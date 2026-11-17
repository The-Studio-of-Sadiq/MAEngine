"""
MAEngine study bridge.

The desktop app stores a study as a folder of part JSON files:

    01 Project Settings/project-settings.json
    02 Geometry/geometry.json        (+ the imported CAD file)
    03 Materials/materials.json
    04 Mesh/mesh.json
    05 Physics & BCs/physics.json
    06 Solver/solver.json
    07 Results/results.json

The engine runs `SimulationProject` specs. This module converts a study into a spec
(resolving the study's box selectors to real CAD faces with Gmsh), runs the pipeline,
and writes the real outputs back into the study folders:

    04 Mesh/model_mesh.inp            mesh + mesh.json counts
    06 Solver/<job>.inp/.frd/.dat/... CalculiX job, calculix.log, solver.json status
    07 Results/<job>.vtu/.gltf/.png   results.json with values read from the .frd

Every number written back comes from Gmsh or CalculiX output. Nothing is estimated.
"""

import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from maengine.schema.model import (
    BoundaryCondition,
    BoundaryConditionType,
    ElasticProperty,
    EntitySet,
    Load,
    LoadType,
    Material,
    MeshAlgorithm,
    MeshConfig,
    SimulationProject,
    Step,
    StepType,
    UnitSystem,
)

PART_FILES = {
    "settings": ("01 Project Settings", "project-settings.json"),
    "geometry": ("02 Geometry", "geometry.json"),
    "materials": ("03 Materials", "materials.json"),
    "mesh": ("04 Mesh", "mesh.json"),
    "physics": ("05 Physics & BCs", "physics.json"),
    "solver": ("06 Solver", "solver.json"),
    "results": ("07 Results", "results.json"),
}

MESH_FILE_NAME = "model_mesh.inp"
SOLVER_LOG_NAME = "calculix.log"
CAD_EXTENSIONS = (".step", ".stp", ".iges", ".igs", ".brep", ".brp")
FRD_FLOAT_RE = re.compile(r"[-+]?\d*\.?\d+[eE][-+]?\d{2,3}")
SET_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
# Selector boxes are compared with face bounding boxes; OCC pads boxes by ~1e-7.
BOX_TOLERANCE = 1e-6
MAX_LISTED_FACES = 500


class StudyError(Exception):
    """The study cannot be run as it stands. `problems` lists every reason found."""

    def __init__(self, problems: List[str]):
        self.problems = problems
        super().__init__("\n".join(problems))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _part_path(study_dir: str, part: str) -> str:
    folder, name = PART_FILES[part]
    return os.path.join(study_dir, folder, name)


def _part_dir(study_dir: str, part: str) -> str:
    return os.path.join(study_dir, PART_FILES[part][0])


def _read_part(study_dir: str, part: str, problems: List[str], required: bool = True) -> Dict[str, Any]:
    path = _part_path(study_dir, part)
    if not os.path.exists(path):
        if required:
            problems.append(f"Missing {os.path.relpath(path, study_dir)}.")
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        problems.append(f"Cannot read {os.path.relpath(path, study_dir)}: {e}")
        return {}
    if not isinstance(data, dict):
        problems.append(f"{os.path.relpath(path, study_dir)} is not a JSON object.")
        return {}
    return data


def _write_json(path: str, data: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent="\t")
        f.write("\n")
    os.replace(tmp, path)


def _update_part(study_dir: str, part: str, changes: Dict[str, Any], remove: Tuple[str, ...] = ()) -> None:
    """Merge `changes` into a part file, keeping the user's other keys."""
    path = _part_path(study_dir, part)
    data: Dict[str, Any] = {}
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                data = loaded
        except (OSError, ValueError):
            data = {}
    data.setdefault("schema", 1)
    for key in remove:
        data.pop(key, None)
    data.update(changes)
    _write_json(path, data)


def _job_name(raw: str) -> str:
    name = re.sub(r"[^A-Za-z0-9_]+", "_", raw or "").strip("_")
    if not name or not name[0].isalpha():
        name = "Study_" + name if name else "Study"
    return name[:60]


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _vector(v: Any) -> Optional[List[float]]:
    if isinstance(v, list) and len(v) == 3 and all(_is_number(x) for x in v):
        return [float(x) for x in v]
    return None


# --------------------------------------------------------------------------------------
# Geometry: resolve selectors against the real CAD file
# --------------------------------------------------------------------------------------

def _resolve_cad_file(study_dir: str, geometry: Dict[str, Any], problems: List[str]) -> Optional[str]:
    cad = geometry.get("cadFile")
    if not isinstance(cad, str) or not cad.strip():
        problems.append("Geometry: no CAD file is set. Import a STEP, IGES or BREP file in the Geometry editor.")
        return None
    candidates = [cad] if os.path.isabs(cad) else [
        os.path.join(_part_dir(study_dir, "geometry"), cad),
        os.path.join(study_dir, cad),
    ]
    for c in candidates:
        if os.path.isfile(c):
            if not c.lower().endswith(CAD_EXTENSIONS):
                problems.append(f"Geometry: '{cad}' is not a STEP, IGES or BREP file.")
                return None
            return os.path.abspath(c)
    problems.append(
        f"Geometry: CAD file '{cad}' was not found in '{PART_FILES['geometry'][0]}'. "
        "Import a STEP, IGES or BREP file in the Geometry editor."
    )
    return None


def inspect_cad(cad_path: str, selectors: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Opens the CAD file the same way the mesher does (import + multi-body fragment) and returns
    the model bounds, the bodies with their volumes, and the face tags each box selector picks.
    """
    import gmsh

    result: Dict[str, Any] = {"bounds": None, "bodies": [], "faces": {}, "face_boxes": []}
    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Verbosity", 1)
        gmsh.model.add("MAEngineInspect")
        gmsh.model.occ.importShapes(cad_path)
        gmsh.model.occ.synchronize()
        volumes = gmsh.model.getEntities(dim=3)
        if len(volumes) > 1:
            gmsh.model.occ.fragment([(3, v[1]) for v in volumes], [])
            gmsh.model.occ.synchronize()
            volumes = gmsh.model.getEntities(dim=3)
        result["bounds"] = list(gmsh.model.getBoundingBox(-1, -1))
        for _, tag in volumes:
            result["bodies"].append({"tag": tag, "volume": gmsh.model.occ.getMass(3, tag)})
        for _, tag in gmsh.model.getEntities(dim=2):
            result["face_boxes"].append((tag, list(gmsh.model.getBoundingBox(2, tag))))
        for sel in selectors:
            b = sel["bounds"]
            t = BOX_TOLERANCE
            picked = gmsh.model.getEntitiesInBoundingBox(
                b[0] - t, b[1] - t, b[2] - t, b[3] + t, b[4] + t, b[5] + t, dim=2
            )
            result["faces"][sel["name"]] = sorted(tag for _, tag in picked)
    finally:
        gmsh.finalize()
    return result


def _fmt_box(b: List[float]) -> str:
    return "[" + ", ".join(f"{v:g}" for v in (round(x, 4) + 0.0 for x in b)) + "]"


# --------------------------------------------------------------------------------------
# Study -> engine spec
# --------------------------------------------------------------------------------------

def load_study(study_dir: str, stage: str = "run") -> Tuple[SimulationProject, Dict[str, Any]]:
    """
    Converts a study folder into a `SimulationProject`. Raises `StudyError` listing every
    problem that stops the study from running. The returned context carries what the runner
    needs to write results back (CAD path, inspection data, material card, notes).
    """
    study_dir = os.path.abspath(study_dir)
    problems: List[str] = []
    notes: List[str] = []

    if not os.path.isdir(study_dir):
        raise StudyError([f"Study folder not found: {study_dir}"])

    settings = _read_part(study_dir, "settings", problems)
    geometry = _read_part(study_dir, "geometry", problems)
    materials_part = _read_part(study_dir, "materials", problems)
    mesh_part = _read_part(study_dir, "mesh", problems)
    physics = _read_part(study_dir, "physics", problems)
    solver = _read_part(study_dir, "solver", problems)

    # ---- settings
    proj = settings.get("project", {}) if isinstance(settings.get("project"), dict) else {}
    job = _job_name(str(proj.get("name") or os.path.basename(study_dir)))
    units = proj.get("unitSystem", "mm_N_MPa_tonne_s")
    if units != UnitSystem.MM_N_MPA.value:
        problems.append(
            f"Study Settings: unit system '{units}' cannot run yet. Material cards and loads are stored "
            "in mm, N, MPa and tonne, so only 'mm_N_MPa_tonne_s' studies can be solved."
        )

    # ---- geometry
    cad_path = _resolve_cad_file(study_dir, geometry, problems)
    raw_selectors = geometry.get("selectors") or []
    selectors: List[Dict[str, Any]] = []
    if not isinstance(raw_selectors, list):
        problems.append("Geometry: 'selectors' must be a list.")
        raw_selectors = []
    seen = set()
    invalid_selectors = set()  # named but unusable: reported once, not again by each load
    for i, sel in enumerate(raw_selectors):
        if isinstance(sel, dict) and isinstance(sel.get("name"), str):
            invalid_selectors.add(sel["name"])
        if not isinstance(sel, dict):
            problems.append(f"Geometry: selector #{i + 1} is not an object.")
            continue
        name = sel.get("name")
        if not isinstance(name, str) or not SET_NAME_RE.match(name):
            problems.append(
                f"Geometry: selector #{i + 1} name {name!r} must start with a letter and use only "
                "letters, digits and '_' (it becomes a CalculiX set name)."
            )
            continue
        if name.upper() in seen or name.upper() in ("EALL", "NALL"):
            problems.append(f"Geometry: selector name '{name}' is duplicated or reserved.")
            continue
        seen.add(name.upper())
        if sel.get("type", "face") != "face":
            problems.append(f"Geometry: selector '{name}' has type '{sel.get('type')}'; only 'face' selectors can run.")
            continue
        if sel.get("rule", "box") != "box":
            problems.append(f"Geometry: selector '{name}' uses rule '{sel.get('rule')}'; only 'box' selectors can run.")
            continue
        b = sel.get("bounds")
        if not (isinstance(b, list) and len(b) == 6 and all(_is_number(x) for x in b)):
            problems.append(f"Geometry: selector '{name}' needs bounds [xmin, ymin, zmin, xmax, ymax, zmax].")
            continue
        b = [float(x) for x in b]
        if b[0] > b[3] or b[1] > b[4] or b[2] > b[5]:
            problems.append(f"Geometry: selector '{name}' bounds have a min greater than a max: {_fmt_box(b)}.")
            continue
        selectors.append({"name": name, "bounds": b})
        invalid_selectors.discard(name)

    # ---- materials
    cards = materials_part.get("materials") if isinstance(materials_part.get("materials"), list) else []
    cards = [c for c in cards if isinstance(c, dict)]
    card: Optional[Dict[str, Any]] = None
    if not cards:
        problems.append("Materials: no material cards are defined.")
    else:
        wanted = geometry.get("material")
        bodies = geometry.get("bodies") if isinstance(geometry.get("bodies"), list) else []
        if not wanted and bodies and isinstance(bodies[0], dict):
            wanted = bodies[0].get("material")
        if wanted:
            card = next((c for c in cards if c.get("id") == wanted), None)
            if card is None:
                problems.append(f"Materials: the body's material '{wanted}' is not in materials.json.")
        else:
            card = cards[0]
            notes.append(
                f"No material is assigned to the body, so the first material card "
                f"'{card.get('name', card.get('id'))}' is used."
            )
    material: Optional[Material] = None
    if card is not None:
        e = card.get("elasticModulus_MPa")
        nu = card.get("poissonsRatio")
        rho = card.get("density_tonne_mm3")
        mid = _job_name(str(card.get("id") or card.get("name") or "MATERIAL"))
        if not _is_number(e) or e <= 0:
            problems.append(f"Materials: '{mid}' needs a positive elasticModulus_MPa.")
        if not _is_number(nu) or not (0.0 <= nu < 0.5):
            problems.append(f"Materials: '{mid}' needs poissonsRatio between 0 and 0.5.")
        if rho is not None and (not _is_number(rho) or rho <= 0):
            problems.append(f"Materials: '{mid}' density_tonne_mm3 must be a positive number.")
            rho = None
        if _is_number(e) and e > 0 and _is_number(nu) and 0.0 <= nu < 0.5:
            material = Material(
                name=mid,
                density=float(rho) if rho is not None else None,
                elastic=ElasticProperty(youngs_modulus=float(e), poissons_ratio=float(nu)),
            )

    # ---- mesh
    order = mesh_part.get("meshOrder", 2)
    if order not in (1, 2):
        problems.append(f"Mesh: meshOrder must be 1 or 2 (got {order!r}).")
        order = 2
    min_size = mesh_part.get("minSize", 1.0)
    max_size = mesh_part.get("maxSize", 10.0)
    global_size = mesh_part.get("globalSize")
    if not _is_number(min_size) or min_size <= 0 or not _is_number(max_size) or max_size <= 0:
        problems.append("Mesh: minSize and maxSize must be positive numbers.")
        min_size, max_size = 1.0, 10.0
    elif min_size > max_size:
        problems.append(f"Mesh: minSize ({min_size}) is larger than maxSize ({max_size}).")
    if _is_number(global_size) and global_size > 0:
        # The global size is the target element size; it caps the maximum.
        max_size = max(float(min_size), min(float(max_size), float(global_size)))
    mesh_config = MeshConfig(
        element_order=int(order),
        algorithm=MeshAlgorithm.HXT_PARALLEL,
        min_size=float(min_size),
        max_size=float(max_size),
        optimize_high_order=bool(mesh_part.get("optimizeHighOrder", True)),
    )

    # ---- physics
    selector_names = {s["name"] for s in selectors}
    bcs: List[BoundaryCondition] = []
    loads: List[Load] = []
    used_sets: List[str] = []

    def check_target(kind: str, ident: str, target: Any) -> Optional[str]:
        if not isinstance(target, str) or not target:
            problems.append(f"Physics: {kind} '{ident}' has no selector.")
            return None
        if target in invalid_selectors:
            return None  # the selector's own problem is already listed
        if target not in selector_names:
            known = ", ".join(sorted(selector_names)) or "none"
            problems.append(
                f"Physics: {kind} '{ident}' targets selector '{target}', which is not defined in "
                f"Geometry (defined: {known})."
            )
            return None
        return target

    constraints = physics.get("constraints") if isinstance(physics.get("constraints"), list) else []
    for i, c in enumerate(constraints):
        if not isinstance(c, dict):
            problems.append(f"Physics: constraint #{i + 1} is not an object.")
            continue
        cid = str(c.get("id") or f"bc_{i + 1}")
        target = check_target("constraint", cid, c.get("selector"))
        ctype = c.get("type")
        if ctype == "fixed":
            if target:
                bcs.append(BoundaryCondition(name=cid, type=BoundaryConditionType.FIXED, target_set=target))
                used_sets.append(target)
        elif ctype == "displacement":
            vals = {k: c.get(k) for k in ("ux", "uy", "uz")}
            if not any(_is_number(v) for v in vals.values()):
                problems.append(f"Physics: displacement constraint '{cid}' needs at least one of ux, uy, uz.")
            elif target:
                bcs.append(BoundaryCondition(
                    name=cid, type=BoundaryConditionType.DISPLACEMENT, target_set=target,
                    u1=vals["ux"] if _is_number(vals["ux"]) else None,
                    u2=vals["uy"] if _is_number(vals["uy"]) else None,
                    u3=vals["uz"] if _is_number(vals["uz"]) else None,
                ))
                used_sets.append(target)
        else:
            problems.append(f"Physics: constraint '{cid}' has type {ctype!r}; supported: 'fixed', 'displacement'.")
    if not bcs and not any(p.startswith("Physics: constraint") for p in problems):
        problems.append("Physics: no supports are defined. Add at least one fixed constraint so the part cannot float.")

    raw_loads = physics.get("loads") if isinstance(physics.get("loads"), list) else []
    for i, ld in enumerate(raw_loads):
        if not isinstance(ld, dict):
            problems.append(f"Physics: load #{i + 1} is not an object.")
            continue
        lid = str(ld.get("id") or f"load_{i + 1}")
        ltype = ld.get("type")
        if ltype == "force":
            target = check_target("load", lid, ld.get("selector"))
            vec = _vector(ld.get("vector"))
            if vec is None:
                problems.append(f"Physics: force load '{lid}' needs vector [Fx, Fy, Fz] in N.")
                continue
            mag = sum(x * x for x in vec) ** 0.5
            if mag == 0:
                problems.append(f"Physics: force load '{lid}' has a zero vector.")
                continue
            if target:
                loads.append(Load(name=lid, type=LoadType.CONCENTRATED_FORCE, target_set=target,
                                  magnitude=mag, direction=[x / mag for x in vec]))
                used_sets.append(target)
        elif ltype == "pressure":
            target = check_target("load", lid, ld.get("selector"))
            mag = ld.get("magnitude")
            if not _is_number(mag):
                problems.append(f"Physics: pressure load '{lid}' needs magnitude in MPa.")
                continue
            if mag == 0:
                problems.append(f"Physics: pressure load '{lid}' has a zero magnitude.")
                continue
            if target:
                loads.append(Load(name=lid, type=LoadType.PRESSURE, target_set=target, magnitude=float(mag)))
                used_sets.append(target)
        else:
            problems.append(f"Physics: load '{lid}' has type {ltype!r}; supported: 'force', 'pressure'.")

    gravity = physics.get("gravity")
    if gravity is not None:
        gvec = _vector(gravity)
        if gvec is None:
            problems.append("Physics: gravity must be [gx, gy, gz] in mm/s² (or null for none).")
        else:
            gmag = sum(x * x for x in gvec) ** 0.5
            if gmag > 0:
                if material is not None and material.density is None:
                    problems.append("Physics: gravity is set but the material has no density_tonne_mm3.")
                loads.append(Load(name="gravity", type=LoadType.GRAVITY, target_set="EALL",
                                  magnitude=gmag, direction=[x / gmag for x in gvec]))
    if not loads:
        notes.append("No loads are applied; the solution will be zero displacement.")

    # ---- solver
    analysis = solver.get("analysisType", "static_linear")
    if analysis != "static_linear":
        problems.append(
            f"Solver: analysis type '{analysis}' cannot run from a study yet; only 'static_linear' is connected."
        )

    # ---- resolve selectors on the real CAD file (only when the rest is sane enough to matter)
    inspection: Optional[Dict[str, Any]] = None
    sets: List[EntitySet] = []
    if cad_path:
        try:
            inspection = inspect_cad(cad_path, selectors)
        except Exception as e:  # gmsh raises plain Exceptions
            problems.append(f"Geometry: Gmsh could not open '{os.path.basename(cad_path)}': {e}")
    if inspection is not None:
        if not inspection["bodies"]:
            problems.append(f"Geometry: '{os.path.basename(cad_path)}' contains no solid bodies to mesh.")
        model_box = _fmt_box(inspection["bounds"])
        for sel in selectors:
            tags = inspection["faces"].get(sel["name"], [])
            if not tags:
                if sel["name"] in used_sets:
                    problems.append(
                        f"Geometry: selector '{sel['name']}' box {_fmt_box(sel['bounds'])} contains no whole "
                        f"face of the CAD model (model bounds {model_box}). A face is picked only when its "
                        "bounding box lies inside the selector box."
                    )
                continue
            sets.append(EntitySet(name=sel["name"], entity_type="surface", cad_tag_indices=tags))

    if stage == "mesh":
        # Meshing needs geometry, selectors and mesh settings only; physics and solver
        # problems are reported but do not block it.
        later = [p for p in problems if p.startswith(("Physics:", "Solver:"))]
        problems = [p for p in problems if p not in later]
        notes.extend(f"Before solving: {p}" for p in later)
    if problems:
        raise StudyError(problems)

    project = SimulationProject(
        name=job,
        units=UnitSystem.MM_N_MPA,
        cad_file=cad_path,
        materials=[material] if material else [],
        sets=sets,
        mesh=mesh_config,
        steps=[Step(name="Static_Step", type=StepType.STATIC_LINEAR, boundary_conditions=bcs, loads=loads)],
    )
    context = {
        "study_dir": study_dir,
        "cad_path": cad_path,
        "inspection": inspection,
        "material_card": card,
        "notes": notes,
        "geometry": geometry,
    }
    return project, context


# --------------------------------------------------------------------------------------
# Result extraction straight from the CalculiX .frd
# --------------------------------------------------------------------------------------

def _read_nsets(mesh_path: str, names: List[str]) -> Dict[str, set]:
    wanted = {n.upper(): n for n in names}
    found: Dict[str, set] = {n: set() for n in names}
    current: Optional[str] = None
    generate = False
    with open(mesh_path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            s = line.strip()
            if s.startswith("*"):
                current = None
                if s.upper().startswith("*NSET"):
                    generate = "GENERATE" in s.upper()
                    for part in s.split(","):
                        if part.strip().upper().startswith("NSET="):
                            key = part.split("=", 1)[1].strip().upper()
                            current = wanted.get(key)
                continue
            if current and s:
                nums = [int(t) for t in s.split(",") if t.strip().lstrip("-").isdigit()]
                if generate and len(nums) >= 2:
                    step = nums[2] if len(nums) >= 3 else 1
                    found[current].update(range(nums[0], nums[1] + 1, step))
                else:
                    found[current].update(nums)
    return found


def read_frd_reactions(frd_path: str) -> Dict[int, List[float]]:
    """Nodal reaction forces (the FORC block of the last increment) from a CalculiX .frd."""
    forces: Dict[int, List[float]] = {}
    in_forc = False
    with open(frd_path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.startswith(" -4"):
                in_forc = line[5:13].strip() == "FORC"
                if in_forc:
                    forces = {}  # keep only the last increment's block
                continue
            if in_forc:
                if line.startswith(" -3"):
                    in_forc = False
                elif line.startswith(" -1"):
                    # Fields are nominally 12 wide, but this CalculiX build writes 3-digit
                    # exponents, so a negative value runs into its neighbour: parse by pattern.
                    nid = int(line[3:13])
                    vals = [float(v) for v in FRD_FLOAT_RE.findall(line[13:])]
                    if len(vals) >= 3:
                        forces[nid] = vals[:3]
    return forces


# --------------------------------------------------------------------------------------
# Runner
# --------------------------------------------------------------------------------------

RUN_LOG_NAME = "run.log"
_run_log_path: Optional[str] = None


def _log(msg: str) -> None:
    """Prints and appends to '06 Solver/run.log', which the app's Solver editor shows."""
    print(msg, flush=True)
    if _run_log_path:
        try:
            with open(_run_log_path, "a", encoding="utf-8") as f:
                f.write(msg + "\n")
        except OSError:
            pass


def _mesh_is_current(study_dir: str, cad_path: str) -> bool:
    mesh_path = os.path.join(_part_dir(study_dir, "mesh"), MESH_FILE_NAME)
    if not os.path.exists(mesh_path):
        return False
    mesh_time = os.path.getmtime(mesh_path)
    inputs = [cad_path, _part_path(study_dir, "geometry"), _part_path(study_dir, "mesh")]
    return all(not os.path.exists(p) or os.path.getmtime(p) <= mesh_time for p in inputs)


def _clear_outputs(folder: str, job: str, extra: Tuple[str, ...] = ()) -> None:
    if not os.path.isdir(folder):
        return
    for name in os.listdir(folder):
        path = os.path.join(folder, name)
        if not os.path.isfile(path):
            continue
        stem, ext = os.path.splitext(name)
        if (stem == job and ext.lower() in (".inp", ".frd", ".dat", ".sta", ".cvg", ".12d", ".vtu", ".gltf")) \
                or name == f"{job}_contour.png" or name in extra or name == "spooles.out":
            os.remove(path)


def _model_record(inspection: Dict[str, Any], old: List[Any], card: Dict[str, Any]) -> Dict[str, Any]:
    """geometry.json keys that describe the CAD model as Gmsh reads it: bodies, bounds, faces."""
    bodies = []
    for i, b in enumerate(inspection.get("bodies") or []):
        prev = old[i] if i < len(old) and isinstance(old[i], dict) else {}
        bodies.append({
            "id": prev.get("id", f"body_{i + 1}"),
            "name": prev.get("name", f"Body {i + 1}"),
            "material": prev.get("material", card.get("id")),
            "volume_mm3": round(b["volume"], 3),
        })
    rnd = lambda box: [round(x, 6) + 0.0 for x in box]
    faces = [{"tag": tag, "bounds": rnd(box)} for tag, box in (inspection.get("face_boxes") or [])[:MAX_LISTED_FACES]]
    record: Dict[str, Any] = {"bodies": bodies, "faces": faces}
    if inspection.get("bounds"):
        record["modelBounds"] = rnd(inspection["bounds"])
    return record


def _sync_bodies(study_dir: str, context: Dict[str, Any]) -> None:
    """Records the bodies, model bounds and faces Gmsh found in the CAD file in geometry.json."""
    geometry = context.get("geometry") or {}
    old = geometry.get("bodies") if isinstance(geometry.get("bodies"), list) else []
    record = _model_record(context.get("inspection") or {}, old, context.get("material_card") or {})
    if any(geometry.get(k) != v for k, v in record.items()):
        _update_part(study_dir, "geometry", record)


def inspect_study(study_dir: str) -> int:
    """Reads the CAD file only (no other part needs to be complete) and records the model in geometry.json."""
    problems: List[str] = []
    geometry = _read_part(study_dir, "geometry", problems)
    cad_path = _resolve_cad_file(study_dir, geometry, problems) if not problems else None
    if cad_path is None:
        _log("[-] Cannot read the model:")
        for p in problems:
            _log(f"    - {p}")
        return 2
    try:
        inspection = inspect_cad(cad_path, [])
    except Exception as e:  # gmsh raises plain Exceptions
        _log(f"[-] Gmsh could not open '{os.path.basename(cad_path)}': {e}")
        return 1
    old = geometry.get("bodies") if isinstance(geometry.get("bodies"), list) else []
    record = _model_record(inspection, old, {})
    if any(geometry.get(k) != v for k, v in record.items()):
        _update_part(study_dir, "geometry", record)
    n_faces = len(inspection["face_boxes"])
    shown = f" (first {MAX_LISTED_FACES} listed)" if n_faces > MAX_LISTED_FACES else ""
    _log(f"[+] Read '{os.path.basename(cad_path)}': {len(record['bodies'])} bodies, {n_faces} faces{shown}, "
         f"bounds {_fmt_box(inspection['bounds'])}.")
    return 0


def mesh_study(project: SimulationProject, context: Dict[str, Any]) -> Dict[str, Any]:
    from maengine.meshing.gmsh_mesher import GmshMesher

    study_dir = context["study_dir"]
    mesh_dir = _part_dir(study_dir, "mesh")
    os.makedirs(mesh_dir, exist_ok=True)
    mesh_path = os.path.join(mesh_dir, MESH_FILE_NAME)
    if os.path.exists(mesh_path):
        os.remove(mesh_path)
    # geometry.json is written before the mesh so the mesh stays newer than its inputs.
    _sync_bodies(study_dir, context)

    surface_tags = {s.name: s.cad_tag_indices for s in project.sets if s.cad_tag_indices}
    _log(f"[*] Meshing {os.path.basename(project.cad_file)} with Gmsh "
         f"(order {project.mesh.element_order}, size {project.mesh.min_size:g}-{project.mesh.max_size:g} mm)...")
    with GmshMesher() as mesher:
        stats = mesher.mesh_cad_file(
            cad_path=project.cad_file,
            output_mesh_path=mesh_path,
            config=project.mesh,
            surface_tags=surface_tags or None,
        )
    for name, count in stats.get("nset_node_counts", {}).items():
        if count <= 0:
            raise RuntimeError(f"Selector '{name}' produced no mesh nodes.")
    _update_part(study_dir, "mesh", {
        "meshFile": MESH_FILE_NAME,
        "status": "meshed",
        "nodeCount": stats["num_nodes"],
        "elementCount": stats["num_3d_elements"],
        "setNodeCounts": stats.get("nset_node_counts", {}),
        "meshedAt": _now(),
    })
    _log(f"[+] Mesh written to {os.path.relpath(mesh_path, study_dir)}: "
         f"{stats['num_nodes']} nodes, {stats['num_3d_elements']} elements.")
    return stats


def solve_study(project: SimulationProject, context: Dict[str, Any]) -> Dict[str, Any]:
    from maengine.pipeline import SimulationPipeline

    study_dir = context["study_dir"]
    job = project.name
    solver_dir = _part_dir(study_dir, "solver")
    results_dir = _part_dir(study_dir, "results")
    mesh_src = os.path.join(_part_dir(study_dir, "mesh"), MESH_FILE_NAME)
    log_path = os.path.join(solver_dir, SOLVER_LOG_NAME)

    _clear_outputs(solver_dir, job, extra=(MESH_FILE_NAME, SOLVER_LOG_NAME))
    _clear_outputs(results_dir, job)
    # CalculiX strips blanks from *INCLUDE paths, so the job runs on a copy of the mesh next
    # to the deck instead of '../04 Mesh/...'.
    shutil.copyfile(mesh_src, os.path.join(solver_dir, MESH_FILE_NAME))

    started = _now()
    _update_part(study_dir, "solver", {"status": "running", "lastRun": {"job": job, "startedAt": started}})
    _update_part(study_dir, "results", {"hasResults": False}, remove=("resultFile", "gltfFile", "imageFile", "solvedAt"))

    pipeline = SimulationPipeline(project, work_dir=solver_dir)
    pipeline.mesh_path = os.path.join(solver_dir, MESH_FILE_NAME)
    pipeline.compile_solver_deck()

    _log(f"[*] Solving {job} with CalculiX ({pipeline.runner.ccx_path})...")
    with open(log_path, "w", encoding="utf-8") as log:
        def on_line(line: str) -> None:
            log.write(line)
            log.flush()
        res = pipeline.solve(on_output_line=on_line)

    if not res.get("success"):
        err = res.get("error") or "CalculiX did not complete the job."
        _update_part(study_dir, "solver", {"status": "failed", "lastRun": {
            "job": job, "startedAt": started, "finishedAt": _now(), "error": err}})
        raise RuntimeError(f"CalculiX failed: {err} (see {os.path.relpath(log_path, study_dir)})")

    _update_part(study_dir, "solver", {"status": "converged", "lastRun": {
        "job": job, "startedAt": started, "finishedAt": _now(), "frdFile": f"{job}.frd"}})
    _log(f"[+] CalculiX job completed: {os.path.relpath(pipeline.frd_path, study_dir)}")
    return {"pipeline": pipeline}


def post_study(project: SimulationProject, context: Dict[str, Any], pipeline) -> Dict[str, Any]:
    from maengine.solvers.calculix.reader import CalculixResultReader

    study_dir = context["study_dir"]
    job = project.name
    results_dir = _part_dir(study_dir, "results")
    os.makedirs(results_dir, exist_ok=True)

    reader = CalculixResultReader(pipeline.frd_path)
    reader.vtu_path = os.path.join(results_dir, f"{job}.vtu")
    reader.convert_to_vtu(overwrite=True)
    summary = reader.extract_summary()

    # Reaction force per support, summed over the support's nodes (from the .frd FORC block).
    reactions: Dict[str, List[float]] = {}
    forces = read_frd_reactions(pipeline.frd_path)
    bc_sets = sorted({bc.target_set for st in project.steps for bc in st.boundary_conditions})
    if forces and bc_sets:
        nsets = _read_nsets(pipeline.mesh_path, bc_sets)
        for name in bc_sets:
            total = [0.0, 0.0, 0.0]
            for nid in nsets.get(name, ()):
                f = forces.get(nid)
                if f:
                    total = [total[k] + f[k] for k in range(3)]
            reactions[name] = total

    files = {"resultFile": f"{job}.vtu"}
    try:
        from maengine.post.viewer import FeaResultViewer
        viewer = FeaResultViewer(reader.vtu_path)
        gltf = os.path.join(results_dir, f"{job}.gltf")
        viewer.export_gltf(gltf, scalar_field="STRESS_VM", warp_scale=1.0)
        files["gltfFile"] = os.path.basename(gltf)
        png = os.path.join(results_dir, f"{job}_contour.png")
        viewer.export_screenshot(png, scalar_field="STRESS_VM", warp_scale=1.0)
        files["imageFile"] = os.path.basename(png)
    except Exception as e:  # visual exports are optional; the .vtu holds the data
        _log(f"[!] 3D export skipped: {e}")

    max_vm = summary.get("max_von_mises_stress")
    card = context.get("material_card") or {}
    yield_mpa = card.get("yieldStrength_MPa")
    safety = (yield_mpa / max_vm) if _is_number(yield_mpa) and max_vm else None

    # Minimums straight from the result grid (the summary helper only reports maxima).
    import numpy as np
    grid = reader.load_pyvista_grid()
    min_vm = float(np.min(grid.point_data["STRESS_VM"])) if "STRESS_VM" in grid.point_data else None
    min_disp = float(np.min(grid.point_data["DISP_MAG"])) if "DISP_MAG" in grid.point_data else None

    def sig(v: Optional[float]) -> Optional[float]:
        return float(f"{v:.6g}") if v is not None else None

    result = {
        "hasResults": True,
        **files,
        "summary": {
            "maxVonMises_MPa": sig(max_vm),
            "minVonMises_MPa": sig(min_vm),
            "maxDisplacement_mm": sig(summary.get("max_displacement")),
            "minDisplacement_mm": sig(min_disp),
            "minSafetyFactor": sig(safety),
            "reactionForces_N": {k: [sig(x) for x in v] for k, v in reactions.items()},
        },
        "material": card.get("id"),
        "job": job,
        "solvedAt": _now(),
    }
    _update_part(study_dir, "results", result)
    _log(f"[+] Results written to {os.path.relpath(results_dir, study_dir)}:")
    _log(f"    - Max von Mises:    {max_vm:.4f} MPa")
    _log(f"    - Max displacement: {summary.get('max_displacement'):.6f} mm")
    for name, r in reactions.items():
        _log(f"    - Reaction on {name}: [{r[0]:.3f}, {r[1]:.3f}, {r[2]:.3f}] N")
    return result


def run_project(study_dir: str, stage: str = "run") -> int:
    """
    stage: 'inspect' reads the CAD model into geometry.json; 'check' validates only; 'mesh' meshes; 'solve' meshes if the mesh is missing or older
    than its inputs, then solves and post-processes; 'run' always re-meshes, then solves.
    Returns a process exit code (0 ok, 2 study incomplete, 1 run failed).
    """
    global _run_log_path
    study_dir = os.path.abspath(study_dir)
    _run_log_path = None
    solver_dir = _part_dir(study_dir, "solver")
    if os.path.isdir(solver_dir):
        _run_log_path = os.path.join(solver_dir, RUN_LOG_NAME)
        with open(_run_log_path, "w", encoding="utf-8") as f:
            f.write(f"MAEngine study run ({stage}) started {_now()}\n")
    _log(f"[*] MAEngine study: {study_dir}")
    if stage == "inspect":
        return inspect_study(study_dir)
    try:
        project, context = load_study(study_dir, stage)
    except StudyError as e:
        _log("[-] The study is not ready to run:")
        for p in e.problems:
            _log(f"    - {p}")
        if stage in ("solve", "run") and os.path.exists(_part_path(study_dir, "solver")):
            # Earlier outputs no longer describe the study as it stands; say this run failed.
            solver_json = _part_path(study_dir, "solver")
            last_run: Dict[str, Any] = {
                "startedAt": _now(),
                "error": "The study is not ready to run (see run.log).",
            }
            try:
                with open(solver_json, "r", encoding="utf-8") as f:
                    loaded = json.load(f)
                if isinstance(loaded, dict):
                    prev = loaded.get("lastRun")
                    if isinstance(prev, dict):
                        frd = prev.get("frdFile")
                        if isinstance(frd, str) and frd.strip():
                            last_run["frdFile"] = frd
            except (OSError, ValueError):
                pass
            _update_part(study_dir, "solver", {"status": "failed", "lastRun": last_run})
        return 2
    for note in context["notes"]:
        _log(f"[i] {note}")
    sets = ", ".join(f"{s.name} -> faces {s.cad_tag_indices}" for s in project.sets) or "none"
    _log(f"[*] Job '{project.name}', material {project.materials[0].name}, selectors: {sets}")
    if stage == "check":
        _log("[+] The study is complete and can run.")
        return 0

    try:
        if stage in ("mesh", "run") or not _mesh_is_current(study_dir, context["cad_path"]):
            mesh_study(project, context)
            if stage == "mesh":
                return 0
        else:
            _log("[*] Reusing the current mesh in '04 Mesh'.")
        solved = solve_study(project, context)
        post_study(project, context, solved["pipeline"])
    except Exception as e:
        solver_json = _part_path(study_dir, "solver")
        try:
            with open(solver_json, "r", encoding="utf-8") as f:
                status = json.load(f).get("status")
        except (OSError, ValueError):
            status = None
        if status == "running":
            _update_part(study_dir, "solver", {"status": "failed"})
        _log(f"[-] Run failed: {e}")
        return 1
    _log("[+] Study run completed.")
    return 0


if __name__ == "__main__":
    sys.exit(run_project(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "run"))

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
    "reports": ("09 Reports", "reports.json"),
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

    # ---- materials (cards are checked here; which body uses which card is settled after the
    # CAD file is read, once the number of bodies is known)
    cards = materials_part.get("materials") if isinstance(materials_part.get("materials"), list) else []
    cards = [c for c in cards if isinstance(c, dict)]
    cards_by_id = {str(c.get("id")): c for c in cards if c.get("id") is not None}
    geo_bodies = geometry.get("bodies") if isinstance(geometry.get("bodies"), list) else []
    default_card: Optional[Dict[str, Any]] = None
    if not cards:
        problems.append("Materials: no material cards are defined.")
    else:
        wanted = geometry.get("material")
        default_card = cards_by_id.get(str(wanted)) if wanted else cards[0]
        if wanted and default_card is None:
            problems.append(f"Materials: the study material '{wanted}' is not in materials.json.")
    built: Dict[int, Optional[Material]] = {}

    def material_from(card: Dict[str, Any]) -> Optional[Material]:
        """One CalculiX material per card; problems are reported once per card."""
        if id(card) in built:
            return built[id(card)]
        e = card.get("elasticModulus_MPa")
        nu = card.get("poissonsRatio")
        rho = card.get("density_tonne_mm3")
        mid = _job_name(str(card.get("id") or card.get("name") or "MATERIAL"))
        mat: Optional[Material] = None
        if not _is_number(e) or e <= 0:
            problems.append(f"Materials: '{mid}' needs a positive elasticModulus_MPa.")
        if not _is_number(nu) or not (0.0 <= nu < 0.5):
            problems.append(f"Materials: '{mid}' needs poissonsRatio between 0 and 0.5.")
        if rho is not None and (not _is_number(rho) or rho <= 0):
            problems.append(f"Materials: '{mid}' density_tonne_mm3 must be a positive number.")
            rho = None
        if _is_number(e) and e > 0 and _is_number(nu) and 0.0 <= nu < 0.5:
            mat = Material(
                name=mid,
                density=float(rho) if rho is not None else None,
                elastic=ElasticProperty(youngs_modulus=float(e), poissons_ratio=float(nu)),
            )
        built[id(card)] = mat
        return mat

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
    algo_names = {"hxt": MeshAlgorithm.HXT_PARALLEL, "delaunay": MeshAlgorithm.DELAUNAY, "frontal": MeshAlgorithm.FRONTAL}
    algorithm = algo_names.get(str(mesh_part.get("algorithm", "hxt")))
    if algorithm is None:
        problems.append(f"Mesh: algorithm must be one of {', '.join(algo_names)} (got {mesh_part.get('algorithm')!r}).")
        algorithm = MeshAlgorithm.HXT_PARALLEL
    mesh_config = MeshConfig(
        element_order=int(order),
        algorithm=algorithm,
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
    frictionless: List[Tuple[str, str]] = []  # resolved once the faces are known
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
        elif ctype == "frictionless":
            # No motion normal to a flat face (also a symmetry plane); the face may slide in-plane.
            if target:
                frictionless.append((cid, target))
                used_sets.append(target)
        else:
            problems.append(f"Physics: constraint '{cid}' has type {ctype!r}; "
                            "supported: 'fixed', 'displacement', 'frictionless'.")
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
    gravity_set = False
    if gravity is not None:
        gvec = _vector(gravity)
        if gvec is None:
            problems.append("Physics: gravity must be [gx, gy, gz] in mm/s² (or null for none).")
        else:
            gmag = sum(x * x for x in gvec) ** 0.5
            if gmag > 0:
                gravity_set = True
                loads.append(Load(name="gravity", type=LoadType.GRAVITY, target_set="EALL",
                                  magnitude=gmag, direction=[x / gmag for x in gvec]))
    if not loads and solver.get("analysisType", "static_linear") != "modal_frequency":
        notes.append("No loads are applied; the solution will be zero displacement.")

    # ---- solver
    analysis = solver.get("analysisType", "static_linear")
    num_modes = solver.get("modes", 10)
    if analysis not in ("static_linear", "modal_frequency"):
        problems.append(
            f"Solver: analysis type '{analysis}' cannot run from a study; supported: 'static_linear', 'modal_frequency'."
        )
    elif analysis == "modal_frequency":
        if not (isinstance(num_modes, int) and not isinstance(num_modes, bool) and 1 <= num_modes <= 100):
            problems.append(f"Solver: modes must be a whole number from 1 to 100 (got {num_modes!r}).")
        if loads:
            notes.append("Modal analysis finds natural frequencies; the loads and gravity are not used.")
        for bc in bcs:
            if bc.type == BoundaryConditionType.DISPLACEMENT and any(v not in (None, 0, 0.0) for v in (bc.u1, bc.u2, bc.u3)):
                problems.append(f"Physics: constraint '{bc.name}' prescribes a non-zero displacement, "
                                "which a modal analysis cannot use (only zero components).")

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

    # ---- frictionless supports: the face normal must be a coordinate axis
    if inspection is not None and frictionless:
        boxes = {tag: box for tag, box in inspection["face_boxes"]}
        size = max((inspection["bounds"][k + 3] - inspection["bounds"][k] for k in range(3)), default=1.0) or 1.0
        for cid, target in frictionless:
            axes = set()
            for tag in inspection["faces"].get(target, []):
                b = boxes.get(tag)
                flat = [k for k in range(3) if b and abs(b[k + 3] - b[k]) <= 1e-6 * size]
                axes.add(flat[0] if len(flat) == 1 else None)
            if not axes:
                continue  # the selector's own "picks no face" problem is already listed
            if len(axes) != 1 or None in axes:
                problems.append(f"Physics: frictionless support '{cid}' needs flat faces facing the same "
                                f"coordinate direction (X, Y or Z); selector '{target}' picks others.")
                continue
            axis = axes.pop()
            comps = {"u1": None, "u2": None, "u3": None}
            comps[f"u{axis + 1}"] = 0.0
            bcs.append(BoundaryCondition(name=cid, type=BoundaryConditionType.DISPLACEMENT, target_set=target, **comps))
            notes.append(f"Frictionless support '{cid}' holds {'XYZ'[axis]} displacement at zero on '{target}'.")

    # ---- materials per body
    n_bodies = len(inspection["bodies"]) if inspection is not None else max(1, len(geo_bodies))
    body_cards: List[Dict[str, Any]] = []
    unassigned = 0
    for i in range(n_bodies):
        prev = geo_bodies[i] if i < len(geo_bodies) and isinstance(geo_bodies[i], dict) else {}
        wanted_body = prev.get("material")
        if wanted_body:
            c = cards_by_id.get(str(wanted_body))
            if c is None:
                problems.append(f"Materials: body '{prev.get('name', f'Body {i + 1}')}' uses '{wanted_body}', "
                                "which is not in materials.json.")
                continue
        else:
            c = default_card
            unassigned += 1
        if c is not None:
            body_cards.append(c)
    used_cards: List[Dict[str, Any]] = []
    for c in body_cards:
        if all(c is not u for u in used_cards):
            used_cards.append(c)
    materials: List[Material] = [m for m in (material_from(c) for c in used_cards) if m is not None]
    if unassigned and default_card is not None:
        notes.append(f"{unassigned} of {n_bodies} bodies have no material assigned and use "
                     f"'{default_card.get('name', default_card.get('id'))}'.")
    if analysis == "modal_frequency":
        for m in materials:
            if m.density is None:
                problems.append(f"Materials: '{m.name}' needs a density (density_tonne_mm3) for modal analysis.")
    elif gravity_set and any(m.density is None for m in materials):
        problems.append("Physics: gravity is set but a material in use has no density_tonne_mm3.")
    body_sections: Optional[List[Dict[str, str]]] = None
    if len(used_cards) > 1 and inspection is not None and len(body_cards) == n_bodies:
        names = {id(c): material_from(c).name for c in used_cards if material_from(c) is not None}
        body_sections = [{"elset": f"BODY_{i + 1}", "material": names.get(id(c), "")}
                         for i, c in enumerate(body_cards)]

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
        materials=materials,
        sets=sets,
        mesh=mesh_config,
        steps=[Step(name="Modal_Step", type=StepType.MODAL_FREQUENCY, num_modes=int(num_modes), boundary_conditions=bcs)]
        if analysis == "modal_frequency" else
        [Step(name="Static_Step", type=StepType.STATIC_LINEAR, boundary_conditions=bcs, loads=loads)],
    )
    context = {
        "study_dir": study_dir,
        "cad_path": cad_path,
        "inspection": inspection,
        "material_card": used_cards[0] if len(used_cards) == 1 else None,
        "material_cards": used_cards,
        "body_sections": body_sections,
        "notes": notes,
        "geometry": geometry,
        "mesh_part": mesh_part,
        "solver_part": solver,
        "analysis": analysis,
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


from maengine.solvers.calculix.reader import _frd_values  # noqa: E402


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
                    vals = _frd_values(line)
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


MESH_SETTING_KEYS = ("meshOrder", "minSize", "maxSize", "globalSize", "optimizeHighOrder", "algorithm")


def _mesh_settings(mesh_part: Dict[str, Any]) -> Dict[str, Any]:
    """The mesh.json keys the user sets (the engine's own outputs, like counts, are left out)."""
    return {k: mesh_part.get(k) for k in MESH_SETTING_KEYS if k in mesh_part}


def _mesh_is_current(study_dir: str, cad_path: str) -> bool:
    """The mesh is current when it is newer than the CAD file and geometry.json (selectors become
    mesh sets) and was made with the mesh settings that mesh.json holds now."""
    mesh_path = os.path.join(_part_dir(study_dir, "mesh"), MESH_FILE_NAME)
    if not os.path.exists(mesh_path):
        return False
    mesh_time = os.path.getmtime(mesh_path)
    inputs = [cad_path, _part_path(study_dir, "geometry")]
    if any(os.path.exists(p) and os.path.getmtime(p) > mesh_time for p in inputs):
        return False
    try:
        with open(_part_path(study_dir, "mesh"), "r", encoding="utf-8") as f:
            mesh_part = json.load(f)
    except (OSError, ValueError):
        return False
    return isinstance(mesh_part, dict) and mesh_part.get("meshedWith") == _mesh_settings(mesh_part)


def _clear_outputs(folder: str, job: str, extra: Tuple[str, ...] = ()) -> None:
    if not os.path.isdir(folder):
        return
    for name in os.listdir(folder):
        path = os.path.join(folder, name)
        if not os.path.isfile(path):
            continue
        stem, ext = os.path.splitext(name)
        if (stem == job and ext.lower() in (".inp", ".frd", ".dat", ".sta", ".cvg", ".12d", ".vtu", ".gltf")) \
                or name in (f"{job}_contour.png", f"{job}_view.json") or name in extra or name == "spooles.out":
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
    # New bodies start unassigned (they use the default card); assignments are the user's.
    record = _model_record(context.get("inspection") or {}, old, {})
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
        # Bodies with different materials get one element set each (BODY_1, ...); the deck
        # then defines EALL from them.
        volume_tags = None
        if context.get("body_sections"):
            tags = [b["tag"] for b in (context.get("inspection") or {}).get("bodies", [])]
            volume_tags = {sec["elset"]: [tags[i]] for i, sec in enumerate(context["body_sections"])}
        stats = mesher.mesh_cad_file(
            cad_path=project.cad_file,
            output_mesh_path=mesh_path,
            config=project.mesh,
            surface_tags=surface_tags or None,
            volume_tags=volume_tags,
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
        "meshedWith": _mesh_settings(context.get("mesh_part") or {}),
        "quality": stats.get("quality"),
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
    _update_part(study_dir, "results", {"hasResults": False}, remove=("resultFile", "gltfFile", "imageFile", "viewFile", "solvedAt"))

    pipeline = SimulationPipeline(project, work_dir=solver_dir)
    pipeline.mesh_path = os.path.join(solver_dir, MESH_FILE_NAME)
    if context.get("body_sections"):
        pipeline.sections = context["body_sections"]
        pipeline.eall_members = [sec["elset"] for sec in context["body_sections"]]
    pipeline.compile_solver_deck()
    threads = (context.get("solver_part") or {}).get("threads")
    if isinstance(threads, int) and not isinstance(threads, bool) and 1 <= threads <= 256:
        os.environ["OMP_NUM_THREADS"] = str(threads)
        _log(f"[*] Using {threads} solver threads.")

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


def read_dat_frequencies(dat_path: str) -> List[Dict[str, float]]:
    """Natural frequencies from the CalculiX .dat eigenvalue table (mode number, Hz)."""
    modes: List[Dict[str, float]] = []
    in_table = False
    with open(dat_path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            if "E I G E N V A L U E   O U T P U T" in line:
                in_table, modes = True, []
                continue
            if in_table:
                parts = line.split()
                if len(parts) >= 4 and parts[0].isdigit():
                    modes.append({"mode": int(parts[0]), "frequency_Hz": float(parts[3])})
                elif modes and not parts:
                    in_table = False
    return modes


def read_frd_mode_shapes(frd_path: str) -> List[Dict[int, List[float]]]:
    """Each DISP block of a modal .frd in order (one per mode): node id -> [ux, uy, uz]."""
    shapes: List[Dict[int, List[float]]] = []
    current: Optional[Dict[int, List[float]]] = None
    with open(frd_path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.startswith(" -4"):
                current = {} if "DISP" in line else None
            elif line.startswith(" -3"):
                if current is not None:
                    shapes.append(current)
                current = None
            elif current is not None and line.startswith(" -1"):
                vals = _frd_values(line)
                if len(vals) >= 3:
                    current[int(line[3:13])] = vals[:3]
    return shapes


REPORT_FILE_NAME = "report.html"


def write_report(project: SimulationProject, context: Dict[str, Any], result: Dict[str, Any]) -> str:
    """
    Writes 09 Reports/report.html: a self-contained record of the run (inputs as the engine used
    them, mesh, results, notes). Every number comes from the study files or the solver output.
    """
    import base64
    import html as h

    study_dir = context["study_dir"]
    reports_dir = _part_dir(study_dir, "reports")
    os.makedirs(reports_dir, exist_ok=True)

    def esc(v: Any) -> str:
        return h.escape(str(v))

    def num(v: Any, unit: str = "") -> str:
        return "n/a" if v is None else f"{float(v):.6g}{(' ' + unit) if unit else ''}"

    def table(headers: List[str], rows: List[List[Any]]) -> str:
        head = "".join(f"<th>{esc(x)}</th>" for x in headers)
        body = "".join("<tr>" + "".join(f"<td>{esc(c)}</td>" for c in r) + "</tr>" for r in rows)
        return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"

    geometry = context.get("geometry") or {}
    mesh: Dict[str, Any] = {}
    try:
        with open(_part_path(study_dir, "mesh"), "r", encoding="utf-8") as f:
            mesh = json.load(f)
    except (OSError, ValueError):
        pass
    step = project.steps[0]
    modal = context.get("analysis") == "modal_frequency"
    sections: List[str] = []

    sections.append("<h2>Model</h2>" + table(["Item", "Value"], [
        ["CAD file", os.path.basename(project.cad_file or "")],
        ["Bodies", len((context.get("inspection") or {}).get("bodies", []))],
        ["Units", "mm, N, MPa, tonne, s"],
        ["Analysis", "Modal (natural frequencies)" if modal else "Linear static"],
    ]))
    mat_rows = []
    for c in context.get("material_cards") or []:
        rho = c.get("density_tonne_mm3")
        mat_rows.append([c.get("name", c.get("id")), num(c.get("elasticModulus_MPa"), "MPa"), num(c.get("poissonsRatio")),
                         num(rho * 1e12 if _is_number(rho) else None, "kg/m³"), num(c.get("yieldStrength_MPa"), "MPa")])
    sections.append("<h2>Materials</h2>" + table(
        ["Material", "Young's modulus", "Poisson's ratio", "Density", "Yield strength"], mat_rows))
    bodies = geometry.get("bodies") if isinstance(geometry.get("bodies"), list) else []
    if bodies:
        sections.append("<h3>Body assignments</h3>" + table(["Body", "Volume", "Material"], [
            [b.get("name"), num(b.get("volume_mm3"), "mm³"), b.get("material") or "(default card)"]
            for b in bodies if isinstance(b, dict)]))
    sel_rows = [[st.name, ", ".join(str(t) for t in st.cad_tag_indices)] for st in project.sets]
    sections.append("<h2>Face selectors</h2>" + (table(["Selector", "CAD faces"], sel_rows) if sel_rows else "<p>None.</p>"))
    q = mesh.get("quality") or {}
    order = "quadratic (10-node tetrahedra)" if project.mesh.element_order == 2 else "linear (4-node tetrahedra)"
    sections.append("<h2>Mesh</h2>" + table(["Item", "Value"], [
        ["Nodes", mesh.get("nodeCount", "n/a")], ["Elements", mesh.get("elementCount", "n/a")],
        ["Element order", order],
        ["Size range", f"{project.mesh.min_size:g} to {project.mesh.max_size:g} mm"],
        ["Min / mean element quality (SICN)", f"{num(q.get('min'))} / {num(q.get('mean'))}" if q else "n/a"],
    ]))
    bc_rows = []
    for bc in step.boundary_conditions:
        if bc.type == BoundaryConditionType.FIXED:
            what = "all displacements zero"
        else:
            what = ", ".join(f"u{'xyz'[k]} = {v:g} mm" for k, v in enumerate((bc.u1, bc.u2, bc.u3)) if v is not None)
        bc_rows.append([bc.name, bc.target_set, what])
    sections.append("<h2>Supports</h2>" + table(["Support", "Selector", "Constraint"], bc_rows))
    if not modal:
        load_rows = []
        for ld in step.loads:
            if ld.type == LoadType.PRESSURE:
                load_rows.append([ld.name, ld.target_set, f"pressure {ld.magnitude:g} MPa"])
            elif ld.type == LoadType.GRAVITY:
                load_rows.append([ld.name, "all bodies", f"{ld.magnitude:g} mm/s² along {[round(x, 4) for x in ld.direction]}"])
            else:
                load_rows.append([ld.name, ld.target_set, f"{ld.magnitude:g} N along {[round(x, 4) for x in ld.direction]}"])
        sections.append("<h2>Loads</h2>" + (table(["Load", "Applied to", "Value"], load_rows) if load_rows else "<p>None.</p>"))

    summary = result.get("summary") or {}
    if modal:
        sections.append("<h2>Natural frequencies</h2>" + table(["Mode", "Frequency"], [
            [m["mode"], num(m["frequency_Hz"], "Hz")] for m in summary.get("modes", [])]))
    else:
        rows = [["Max von Mises stress", num(summary.get("maxVonMises_MPa"), "MPa")],
                ["Max displacement", num(summary.get("maxDisplacement_mm"), "mm")],
                ["Min factor of safety (yield / max von Mises)", num(summary.get("minSafetyFactor"))]]
        for name, f in (summary.get("reactionForces_N") or {}).items():
            rows.append([f"Reaction on {name}", "[" + ", ".join(f"{x:.6g}" for x in f) + "] N"])
        sections.append("<h2>Results</h2>" + table(["Quantity", "Value"], rows))
        image = result.get("imageFile")
        image_path = os.path.join(_part_dir(study_dir, "results"), image) if image else None
        if image_path and os.path.exists(image_path):
            with open(image_path, "rb") as f:
                data = base64.b64encode(f.read()).decode("ascii")
            sections.append(f'<figure><img alt="von Mises stress contour" src="data:image/png;base64,{data}">'
                            "<figcaption>von Mises stress (MPa) on the deformed shape (true scale).</figcaption></figure>")
    notes = context.get("notes") or []
    if notes:
        sections.append("<h2>Notes</h2><ul>" + "".join(f"<li>{esc(n)}</li>" for n in notes) + "</ul>")

    title = f"{project.name}: {'modal' if modal else 'static'} analysis report"
    style = (
        'body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;margin:32px auto;max-width:880px;'
        'padding:0 16px;color:#1d2330;background:#fff}'
        'h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px;border-bottom:1px solid #d9dee7;'
        'padding-bottom:4px}h3{font-size:14px;margin:16px 0 6px}'
        'table{border-collapse:collapse;width:100%;margin:4px 0}th,td{text-align:left;padding:5px 8px;'
        'border-bottom:1px solid #e6e9ef;vertical-align:top}th{background:#f4f6f9;font-weight:600}'
        '.meta,figcaption{color:#5b6475}figcaption{font-size:12px}img{max-width:100%;border:1px solid #e6e9ef}'
        '@media (prefers-color-scheme: dark){body{background:#1e1f22;color:#e3e6ec}th{background:#2a2c31}'
        'th,td,h2{border-color:#33363c}.meta,figcaption{color:#a0a7b4}}'
    )
    page = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        f"<title>{esc(title)}</title><style>{style}</style></head><body>"
        f"<h1>{esc(title)}</h1>"
        f'<p class="meta">Study folder: {esc(os.path.basename(study_dir))} · Solved {esc(result.get("solvedAt", ""))}'
        " · CalculiX via MAEngine</p>"
        + "".join(sections) + "</body></html>"
    )
    out = os.path.join(reports_dir, REPORT_FILE_NAME)
    with open(out, "w", encoding="utf-8") as f:
        f.write(page)
    _update_part(study_dir, "reports", {"exports": [REPORT_FILE_NAME], "report": REPORT_FILE_NAME, "generatedAt": _now()})
    _log(f"[+] Report written to {os.path.relpath(out, study_dir)}")
    return out


def post_modal(project: SimulationProject, context: Dict[str, Any], pipeline) -> Dict[str, Any]:
    """Frequencies and mode shapes of a modal run into 07 Results (no stresses: mode shapes are
    mass-normalised, so their stress values have no physical size)."""
    import numpy as np
    from maengine.solvers.calculix.reader import CalculixResultReader

    study_dir = context["study_dir"]
    job = project.name
    results_dir = _part_dir(study_dir, "results")
    os.makedirs(results_dir, exist_ok=True)
    dat_path = os.path.splitext(pipeline.frd_path)[0] + ".dat"
    modes = read_dat_frequencies(dat_path) if os.path.exists(dat_path) else []
    if not modes:
        raise RuntimeError("CalculiX wrote no eigenvalue table; the modal run found no frequencies.")
    shapes = read_frd_mode_shapes(pipeline.frd_path)

    reader = CalculixResultReader(pipeline.frd_path)
    reader.vtu_path = os.path.join(results_dir, f"{job}.vtu")
    reader.convert_to_vtu(overwrite=True)
    import pyvista as pv
    grid = pv.read(reader.vtu_path)
    # The reader indexes points by sorted node id.
    nids = sorted(shapes[0]) if shapes else []
    if shapes and len(nids) == grid.n_points:
        for k, shape in enumerate(shapes[:len(modes)]):
            grid.point_data[f"MODE_{k + 1}"] = np.array([shape.get(n, [0.0, 0.0, 0.0]) for n in nids], dtype=float)
        for name in ("DISP", "DISP_MAG", "STRESS", "STRESS_VM"):
            if name in grid.point_data:
                del grid.point_data[name]
        grid.save(reader.vtu_path)

    files = {"resultFile": f"{job}.vtu"}
    try:
        view_name = f"{job}_view.json"
        export_result_view(reader.vtu_path, os.path.join(results_dir, view_name), modes=modes)
        files["viewFile"] = view_name
    except Exception as e:
        _log(f"[!] Results view export skipped: {e}")

    result = {
        "hasResults": True,
        "analysisType": "modal_frequency",
        **files,
        "summary": {"modes": [{"mode": m["mode"], "frequency_Hz": float(f"{m['frequency_Hz']:.6g}")} for m in modes]},
        "material": [c.get("id") for c in context.get("material_cards") or []],
        "job": job,
        "solvedAt": _now(),
    }
    _update_part(study_dir, "results", result, remove=("gltfFile", "imageFile"))
    try:
        write_report(project, context, result)
    except Exception as e:
        _log(f"[!] Report not written: {e}")
    _log(f"[+] Natural frequencies written to {os.path.relpath(results_dir, study_dir)}:")
    for m in modes:
        _log(f"    - Mode {m['mode']}: {m['frequency_Hz']:.6g} Hz")
    return result


def export_result_view(vtu_path: str, out_path: str, modes: Optional[List[Dict[str, float]]] = None) -> Dict[str, Any]:
    """
    Writes the outer surface of the result mesh for the app's 3D results viewer as JSON: node
    positions, triangles, nodal displacement and nodal fields (von Mises, displacement magnitude
    and components, stress components). Values are exactly the solver's, rounded to 6 digits.
    """
    import numpy as np
    import pyvista as pv

    grid = pv.read(vtu_path)
    # The surface filter carries every point array onto its own points. (Its vtkOriginalPointIds
    # did not map back to the right nodes for these grids, so the fields are read from it directly.)
    surf = grid.extract_surface(nonlinear_subdivision=0, algorithm="dataset_surface").triangulate()
    faces = np.asarray(surf.faces).reshape(-1, 4)[:, 1:]

    def flat(a: Any) -> List[float]:
        return [float(f"{v:.6g}") for v in np.asarray(a, dtype=float).ravel()]

    fields: Dict[str, Any] = {}
    pd = surf.point_data
    if "STRESS_VM" in pd:
        fields["von_mises"] = {"label": "von Mises stress", "unit": "MPa", "values": flat(pd["STRESS_VM"])}
    if "DISP_MAG" in pd:
        fields["disp_mag"] = {"label": "Total displacement", "unit": "mm", "values": flat(pd["DISP_MAG"])}
    if "DISP" in pd:
        for k, name in enumerate(("ux", "uy", "uz")):
            fields[name] = {"label": f"Displacement {name[1].upper()}", "unit": "mm", "values": flat(pd["DISP"][:, k])}
    if "STRESS" in pd and pd["STRESS"].shape[1] == 6:
        # CalculiX order: xx, yy, zz, xy, yz, zx
        for k, name in enumerate(("sxx", "syy", "szz", "sxy", "syz", "szx")):
            fields[name] = {"label": f"Stress {name[1:].upper()}", "unit": "MPa", "values": flat(pd["STRESS"][:, k])}

    mode_views = []
    for m in modes or []:
        key = f"MODE_{m['mode']}"
        if key in pd:
            shape = pd[key]
            mode_views.append({"mode": m["mode"], "frequency_Hz": m["frequency_Hz"], "displacement": flat(shape)})
            fields[f"mode_{m['mode']}"] = {
                "label": f"Mode {m['mode']} ({m['frequency_Hz']:.4g} Hz) relative displacement",
                "unit": "", "values": flat(np.linalg.norm(shape, axis=1)),
            }
    view = {
        "schema": 1,
        "analysisType": "modal_frequency" if mode_views else "static_linear",
        "modes": mode_views or None,
        "units": {"length": "mm"},
        "positions": flat(surf.points),
        "triangles": [int(v) for v in faces.ravel()],
        "displacement": flat(pd["DISP"]) if "DISP" in pd else (mode_views[0]["displacement"] if mode_views else None),
        "fields": fields,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(view, f, separators=(",", ":"))
    return {"points": int(surf.n_points), "triangles": int(faces.shape[0])}


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
        view_name = f"{job}_view.json"
        export_result_view(reader.vtu_path, os.path.join(results_dir, view_name))
        files["viewFile"] = view_name
    except Exception as e:  # the viewer file is optional; the .vtu holds the data
        _log(f"[!] Results view export skipped: {e}")
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
    # yield / max von Mises is only meaningful with one material; with several the peak stress
    # may sit in a body with a different yield strength, so no single factor is reported.
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
        "material": card.get("id") if card else [c.get("id") for c in context.get("material_cards") or []],
        "job": job,
        "solvedAt": _now(),
    }
    _update_part(study_dir, "results", result)
    try:
        write_report(project, context, result)
    except Exception as e:
        _log(f"[!] Report not written: {e}")
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
    _log(f"[*] Job '{project.name}', materials {', '.join(m.name for m in project.materials)}, selectors: {sets}")
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
        if context.get("analysis") == "modal_frequency":
            post_modal(project, context, solved["pipeline"])
        else:
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

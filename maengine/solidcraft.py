"""SolidCraft parametric CAD integration for MAEngine studies."""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from maengine.project_bridge import PART_FILES, _part_dir, _read_part, _update_part, inspect_study

NOT_FOUND_MSG = (
    "[-] SolidCraft not found. Install it from https://github.com/tangency-labs/solidcraft/releases, then use "
    "'Choose SolidCraft folder...' (setting maengine.solidcraft.path) or set MAENGINE_SOLIDCRAFT_DIR "
    "to the folder holding solidcraft-cli.exe."
)


def _exes() -> Tuple[str, str]:
    is_win = sys.platform == "win32"
    return ("solidcraft-cli.exe" if is_win else "solidcraft-cli", "solidcraft.exe" if is_win else "solidcraft")


def find_solidcraft(override: Optional[str] = None) -> Optional[str]:
    """Return the folder containing SolidCraft CLI and GUI executables, or None.

    `override` (the app's maengine.solidcraft.path setting) is tried first."""
    cli_name, gui_name = _exes()

    def _has_exes(folder: str) -> bool:
        return os.path.isfile(os.path.join(folder, cli_name)) and os.path.isfile(os.path.join(folder, gui_name))

    def _scan(folder: str) -> Optional[str]:
        if not os.path.isdir(folder):
            return None
        if _has_exes(folder):
            return os.path.abspath(folder)
        try:
            for e in os.scandir(folder):
                if e.is_dir() and _has_exes(e.path):
                    return os.path.abspath(e.path)
        except OSError:
            pass
        return None

    # 1. Explicit folder, then the environment variable
    for given in (override, os.environ.get("MAENGINE_SOLIDCRAFT_DIR")):
        if given:
            found = _scan(given)
            if found:
                return found

    # 2. PATH
    which_cli = shutil.which(cli_name) or shutil.which("solidcraft-cli")
    if which_cli:
        cli_dir = os.path.dirname(os.path.abspath(which_cli))
        if _has_exes(cli_dir):
            return cli_dir

    # 3. %ProgramFiles%\SolidCraft and %LOCALAPPDATA%\Programs\SolidCraft
    candidates = []
    if os.environ.get("ProgramFiles"):
        candidates.append(os.path.join(os.environ["ProgramFiles"], "SolidCraft"))
    if os.environ.get("LOCALAPPDATA"):
        candidates.append(os.path.join(os.environ["LOCALAPPDATA"], "Programs", "SolidCraft"))

    for base in candidates:
        found = _scan(base)
        if found:
            return found
    return None


def locate_solidcraft(override: Optional[str] = None) -> int:
    """Print the found SolidCraft directory or an error message; returns exit code 0 or 2."""
    folder = find_solidcraft(override)
    if folder:
        print(f"[+] Found SolidCraft: {folder}", flush=True)
        return 0
    print(NOT_FOUND_MSG, flush=True)
    return 2


def _load_geometry(study_dir: str) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    study = os.path.abspath(study_dir)
    if not os.path.isdir(study):
        print(f"[-] Study folder not found: {study}", flush=True)
        return None, None
    problems: List[str] = []
    geom = _read_part(study, "geometry", problems, required=True)
    if problems:
        for p in problems:
            print(f"[-] {p}", flush=True)
        return None, None
    return study, geom


def _run_cli(cmd: List[str], cwd: str) -> Optional[str]:
    try:
        proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        return "SolidCraft timed out after 300 s."
    if proc.returncode != 0:
        return (proc.stderr or proc.stdout or "").strip() or f"Exit code {proc.returncode}"
    return None


def _open(study_dir: str, override: Optional[str] = None) -> int:
    """Open or create a SolidCraft design for a study and launch the desktop GUI."""
    study, geom = _load_geometry(study_dir)
    if study is None or geom is None:
        return 2

    sc_dir = find_solidcraft(override)
    if not sc_dir:
        print(NOT_FOUND_MSG, flush=True)
        return 2

    cli_name, gui_name = _exes()
    cli_exe, gui_exe = os.path.join(sc_dir, cli_name), os.path.join(sc_dir, gui_name)
    geom_dir = _part_dir(study, "geometry")
    os.makedirs(geom_dir, exist_ok=True)

    design_name = geom.get("solidcraftDesign")
    cad_file = geom.get("cadFile")
    if not design_name or not isinstance(design_name, str) or not design_name.strip():
        design_name = f"{Path(cad_file).stem}.sc" if (cad_file and isinstance(cad_file, str) and cad_file.strip()) else "geometry.sc"

    design_path = os.path.join(geom_dir, design_name) if not os.path.isabs(design_name) else design_name
    design_name = os.path.basename(design_path)

    if not os.path.isfile(design_path):
        cad_path = os.path.join(geom_dir, cad_file) if (cad_file and not os.path.isabs(cad_file)) else cad_file
        is_step = bool(
            isinstance(cad_file, str)
            and os.path.splitext(cad_file)[1].lower() in (".step", ".stp")
            and isinstance(cad_path, str)
            and os.path.isfile(cad_path)
        )
        if is_step:
            print(f"[*] Importing '{os.path.basename(cad_path)}' into SolidCraft design '{design_name}'...", flush=True)
            err = _run_cli([cli_exe, "run", "--in", cad_path, "--save", design_path, "--quiet"], cwd=geom_dir)
        else:
            print(f"[*] Creating new SolidCraft design '{design_name}'...", flush=True)
            with tempfile.TemporaryDirectory() as tmp_dir:
                script_path = os.path.join(tmp_dir, "init.json")
                with open(script_path, "w", encoding="utf-8") as f:
                    f.write('{"commands": []}\n')
                err = _run_cli([cli_exe, "run", script_path, "--save", design_path, "--quiet"], cwd=geom_dir)
        if err:
            for line in err.splitlines():
                print(f"[-] {line}", flush=True)
            return 1

    _update_part(study, "geometry", {"solidcraftDesign": design_name})

    try:
        flags = (subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP) if sys.platform == "win32" else 0
        kwargs: Dict[str, Any] = {"creationflags": flags} if sys.platform == "win32" else {"start_new_session": True}
        subprocess.Popen(
            [gui_exe, design_name],
            cwd=geom_dir,
            close_fds=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            **kwargs,
        )
    except OSError as e:
        print(f"[-] Failed to launch SolidCraft GUI: {e}", flush=True)
        return 1

    print(f"[+] Opened SolidCraft design: {os.path.relpath(design_path, study)}", flush=True)
    print('[i] Model the geometry, Save in SolidCraft (Ctrl+S), then use "Update from SolidCraft" in MAEngine.', flush=True)
    return 0


def _export(study_dir: str, override: Optional[str] = None) -> int:
    """Export the study's SolidCraft design to STEP and update geometry.json."""
    study, geom = _load_geometry(study_dir)
    if study is None or geom is None:
        return 2

    design_name = geom.get("solidcraftDesign")
    if not design_name or not isinstance(design_name, str) or not design_name.strip():
        print("[-] No SolidCraft design set in geometry.json (run 'maengine solidcraft open' first).", flush=True)
        return 2

    geom_dir = _part_dir(study, "geometry")
    design_path = os.path.join(geom_dir, design_name) if not os.path.isabs(design_name) else design_name
    if not os.path.isfile(design_path):
        print(f"[-] SolidCraft design '{design_name}' not found in '{PART_FILES['geometry'][0]}'.", flush=True)
        return 2

    sc_dir = find_solidcraft(override)
    if not sc_dir:
        print(NOT_FOUND_MSG, flush=True)
        return 2

    cli_name, _ = _exes()
    cli_exe = os.path.join(sc_dir, cli_name)
    stem = Path(design_path).stem
    step_name = f"{stem}.step"
    step_path = os.path.join(geom_dir, step_name)
    tmp_step_path = os.path.join(geom_dir, f"{stem}.solidcraft-export.step")

    if os.path.exists(tmp_step_path):
        try:
            os.remove(tmp_step_path)
        except OSError:
            pass

    print(f"[*] Exporting STEP from SolidCraft design '{os.path.basename(design_path)}'...", flush=True)
    err = _run_cli([cli_exe, "run", design_path, "--out", tmp_step_path, "--quiet"], cwd=geom_dir)
    if err or not os.path.isfile(tmp_step_path):
        if os.path.exists(tmp_step_path):
            try:
                os.remove(tmp_step_path)
            except OSError:
                pass
        msg = err or "SolidCraft export failed: output STEP was not generated."
        for line in msg.splitlines():
            print(f"[-] {line}", flush=True)
        return 1

    os.replace(tmp_step_path, step_path)
    _update_part(study, "geometry", {"cadFile": step_name, "bodies": []}, remove=("faces", "modelBounds"))
    print(f"[+] Exported STEP model: {os.path.relpath(step_path, study)}", flush=True)
    return inspect_study(study)


class _Tee:
    """Passes output through and keeps the [-]/[+] lines, so the result can be shown in the app."""

    def __init__(self, inner: Any) -> None:
        self.inner, self.lines = inner, []  # type: Any, List[str]

    def write(self, text: str) -> int:
        self.lines.extend(l for l in text.splitlines() if l.startswith(("[-]", "[+]", "[i]")))
        return self.inner.write(text)

    def flush(self) -> None:
        self.inner.flush()


def _with_status(action: str, study_dir: str, run: Any) -> int:
    """Runs `run()`, then records {action, ok, notFound, message, at} as solidcraftStatus in geometry.json.

    The app's terminal is often hidden, so this is how the Geometry editor learns what happened."""
    import contextlib
    from maengine.project_bridge import _now, _part_path

    tee = _Tee(sys.stdout)
    with contextlib.redirect_stdout(tee):
        code = run()
    study = os.path.abspath(study_dir)
    if os.path.isfile(_part_path(study, "geometry")):
        errors = [l[3:].strip() for l in tee.lines if l.startswith("[-]")]
        ok_lines = [l[3:].strip() for l in tee.lines if l.startswith("[+]")]
        message = " ".join(errors) if code != 0 else (ok_lines[-1] if ok_lines else "")
        _update_part(study, "geometry", {"solidcraftStatus": {
            "action": action, "ok": code == 0, "notFound": any(l.startswith("SolidCraft not found") for l in errors),
            "message": message, "at": _now()}})
    return code


def open_in_solidcraft(study_dir: str, override: Optional[str] = None) -> int:
    """Open or create the study's SolidCraft design and launch the desktop app."""
    return _with_status("open", study_dir, lambda: _open(study_dir, override))


def export_from_solidcraft(study_dir: str, override: Optional[str] = None) -> int:
    """Export the study's SolidCraft design to STEP, set it as cadFile and read the model."""
    return _with_status("export", study_dir, lambda: _export(study_dir, override))

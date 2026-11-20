"""
MAEngine High-Level Simulation Pipeline
The central orchestrator connecting CAD (build123d), Meshing (Gmsh),
Deck Compilation (Jinja2), Solver Execution (CalculiX), and Post-Processing (VTK/glTF).
"""

import os
from typing import Optional, Dict, Any, Callable
from maengine.schema.model import SimulationProject
from maengine.meshing.gmsh_mesher import GmshMesher
from maengine.solvers.calculix.deck_generator import CalculixDeckGenerator
from maengine.solvers.calculix.runner import CalculixRunner
from maengine.solvers.calculix.reader import CalculixResultReader
from maengine.post.viewer import FeaResultViewer


class SimulationPipeline:
    def __init__(self, project: SimulationProject, work_dir: Optional[str] = None):
        self.project = project
        self.work_dir = os.path.abspath(work_dir or os.path.join(os.getcwd(), "sim_runs", project.name))
        os.makedirs(self.work_dir, exist_ok=True)

        self.mesh_path = os.path.join(self.work_dir, "model_mesh.inp")
        self.deck_path = os.path.join(self.work_dir, f"{project.name}.inp")
        self.frd_path = os.path.join(self.work_dir, f"{project.name}.frd")
        self.vtu_path = os.path.join(self.work_dir, f"{project.name}.vtu")
        self.gltf_path = os.path.join(self.work_dir, f"{project.name}.gltf")
        self.screenshot_path = os.path.join(self.work_dir, f"{project.name}_contour.png")

        self.runner = CalculixRunner()
        self.mesh_stats: Optional[Dict[str, Any]] = None
        self.nset_node_counts: Dict[str, int] = {}

    @classmethod
    def from_yaml(cls, yaml_path: str, work_dir: Optional[str] = None, output_dir: Optional[str] = None) -> "SimulationPipeline":
        target_dir = output_dir or work_dir
        with open(yaml_path, "r", encoding="utf-8") as f:
            yaml_str = f.read()
        proj = SimulationProject.from_yaml(yaml_str)
        # If CAD file in project is relative, resolve it relative to the YAML directory
        if proj.cad_file and not os.path.isabs(proj.cad_file):
            yaml_dir = os.path.dirname(os.path.abspath(yaml_path))
            proj.cad_file = os.path.join(yaml_dir, proj.cad_file)
        return cls(proj, work_dir=target_dir)

    def generate_mesh(self, cad_file_path: Optional[str] = None) -> Dict[str, Any]:
        """
        Meshes the CAD model into conformal 3D tetrahedral elements using Gmsh.
        """
        cad_path = cad_file_path or self.project.cad_file
        if not cad_path or not os.path.exists(cad_path):
            raise FileNotFoundError(f"CAD file not found: {cad_path}")

        # Map project sets to Gmsh physical groups
        surface_tags = {}
        for entity_set in self.project.sets:
            if entity_set.cad_tag_indices:
                surface_tags[entity_set.name] = entity_set.cad_tag_indices

        with GmshMesher() as mesher:
            stats = mesher.mesh_cad_file(
                cad_path=cad_path,
                output_mesh_path=self.mesh_path,
                config=self.project.mesh,
                surface_tags=surface_tags if surface_tags else None,
            )
        self.mesh_stats = stats
        self.nset_node_counts = stats.get("nset_node_counts", {})
        return stats

    @staticmethod
    def _parse_nset_node_counts(mesh_path: str) -> Dict[str, int]:
        counts: Dict[str, int] = {}
        if not os.path.exists(mesh_path):
            return counts
        curr_nset = None
        is_generate = False
        curr_nodes = set()
        with open(mesh_path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                trimmed = line.strip()
                if trimmed.upper().startswith("*NSET"):
                    if curr_nset and curr_nodes:
                        counts[curr_nset] = len(curr_nodes)
                    curr_nset = None
                    is_generate = "GENERATE" in trimmed.upper()
                    curr_nodes = set()
                    for part in trimmed.split(","):
                        if "NSET=" in part.upper():
                            curr_nset = part.split("=")[-1].strip()
                elif trimmed.startswith("*"):
                    if curr_nset and curr_nodes:
                        counts[curr_nset] = len(curr_nodes)
                    curr_nset = None
                    is_generate = False
                    curr_nodes = set()
                elif curr_nset and trimmed:
                    if is_generate:
                        parts = [int(p.strip()) for p in trimmed.split(",") if p.strip()]
                        if len(parts) >= 2:
                            step = parts[2] if len(parts) >= 3 else 1
                            counts[curr_nset] = (parts[1] - parts[0]) // step + 1
                        curr_nset = None
                        is_generate = False
                    else:
                        for tok in trimmed.split(","):
                            tok = tok.strip()
                            if tok.isdigit():
                                curr_nodes.add(int(tok))
            if curr_nset and curr_nodes:
                counts[curr_nset] = len(curr_nodes)
        return counts

    def compile_solver_deck(self, nset_node_counts: Optional[Dict[str, int]] = None) -> str:
        """
        Compiles the CalculiX .inp file from project schema and generated mesh.
        """
        generator = CalculixDeckGenerator()
        rel_mesh = os.path.basename(self.mesh_path)
        node_counts = nset_node_counts if nset_node_counts is not None else self.nset_node_counts
        if not node_counts and os.path.exists(self.mesh_path):
            node_counts = self._parse_nset_node_counts(self.mesh_path)
            self.nset_node_counts = node_counts

        return generator.generate_deck(
            project=self.project,
            mesh_file_rel_path=rel_mesh,
            output_inp_path=self.deck_path,
            nset_node_counts=node_counts,
            sections=getattr(self, "sections", None),
            eall_members=getattr(self, "eall_members", None),
        )

    def solve(
        self,
        on_output_line: Optional[Callable[[str], None]] = None,
        on_residual: Optional[Callable[[Dict[str, float]], None]] = None,
    ) -> Dict[str, Any]:
        """
        Runs CalculiX CrunchiX on the compiled deck.
        """
        return self.runner.run_job(
            job_dir=self.work_dir,
            job_name=self.project.name,
            on_output_line=on_output_line,
            on_residual=on_residual,
        )

    def post_process(self, warp_scale: float = 1.0) -> Dict[str, Any]:
        """
        Converts .frd results to .vtu, extracts max von Mises stress and deflection,
        and generates .gltf and .png visualizations for VS Code.
        """
        if not os.path.exists(self.frd_path):
            raise FileNotFoundError(f"Result file .frd not found: {self.frd_path}")

        reader = CalculixResultReader(self.frd_path)
        reader.convert_to_vtu(overwrite=True)
        summary = reader.extract_summary()

        viewer = FeaResultViewer(self.vtu_path)
        viewer.export_gltf(self.gltf_path, scalar_field="STRESS_VM", warp_scale=warp_scale)
        viewer.export_screenshot(self.screenshot_path, scalar_field="STRESS_VM", warp_scale=warp_scale)

        summary["gltf_file"] = self.gltf_path
        summary["screenshot_file"] = self.screenshot_path
        return summary

    def run_all(self, cad_file_path: Optional[str] = None) -> Dict[str, Any]:
        """
        Executes the entire end-to-end pipeline in one automated pass:
        CAD Mesh -> Deck Gen -> Solve -> Post-Process (VTU/glTF/PNG).
        """
        mesh_stats = self.generate_mesh(cad_file_path=cad_file_path)
        deck_file = self.compile_solver_deck(nset_node_counts=mesh_stats.get("nset_node_counts"))
        solve_result = self.solve()

        if not solve_result["success"]:
            return {
                "success": False,
                "stage": "solve",
                "error": solve_result.get("error", "Solver failed"),
                "mesh_stats": mesh_stats,
            }

        post_summary = self.post_process()
        return {
            "success": True,
            "mesh_path": self.mesh_path,
            "mesh_stats": mesh_stats,
            "deck_path": deck_file,
            "inp_path": deck_file,
            "vtu_path": self.vtu_path,
            "gltf_path": self.gltf_path,
            "screenshot_path": self.screenshot_path,
            "summary": post_summary,
        }

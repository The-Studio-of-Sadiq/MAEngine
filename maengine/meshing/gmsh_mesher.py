"""
MAEngine Gmsh Meshing Engine
Wraps Gmsh C++/Python API for high-performance 3D conformal tetrahedral meshing.
"""

import os
import re
from typing import List, Dict, Optional, Tuple
import gmsh
from maengine.schema.model import MeshConfig, MeshAlgorithm


class GmshMesher:
    def __init__(self, verbose: int = 1):
        self.verbose = verbose
        self._is_initialized = False

    def __enter__(self):
        self.initialize()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.finalize()

    def initialize(self):
        if not self._is_initialized:
            gmsh.initialize()
            gmsh.option.setNumber("General.Verbosity", self.verbose)
            self._is_initialized = True

    def finalize(self):
        if self._is_initialized:
            gmsh.finalize()
            self._is_initialized = False

    def mesh_cad_file(
        self,
        cad_path: str,
        output_mesh_path: str,
        config: MeshConfig,
        surface_tags: Optional[Dict[str, List[int]]] = None,
        volume_tags: Optional[Dict[str, List[int]]] = None,
    ) -> Dict[str, any]:
        """
        Imports CAD geometry (STEP / IGES / BREP), fragments multi-body interfaces
        conformally, generates 3D tetrahedrals, and writes out Abaqus/CalculiX .inp or .msh.
        """
        self.initialize()
        gmsh.model.add("MAEngineModel")

        # 1. Import CAD via embedded OpenCASCADE
        shapes = gmsh.model.occ.importShapes(cad_path)
        gmsh.model.occ.synchronize()

        # 2. Extract volumes and surfaces
        volumes = gmsh.model.getEntities(dim=3)
        surfaces = gmsh.model.getEntities(dim=2)

        # 3. Non-manifold boolean fragmentation for multi-body assemblies
        if len(volumes) > 1:
            # Shared Topology: Splits overlapping boundaries into conformal matching interfaces
            v_tags = [v[1] for v in volumes]
            gmsh.model.occ.fragment([(3, v) for v in v_tags], [])
            gmsh.model.occ.synchronize()
            volumes = gmsh.model.getEntities(dim=3)
            surfaces = gmsh.model.getEntities(dim=2)

        # 4. Configure mesh algorithm and sizing
        # Algorithm 3D: 1=Delaunay, 4=Frontal, 10=HXT (parallel)
        algo_map = {
            MeshAlgorithm.HXT_PARALLEL: 10,
            MeshAlgorithm.DELAUNAY: 1,
            MeshAlgorithm.FRONTAL: 4,
            MeshAlgorithm.NETGEN: 1,
        }
        gmsh.option.setNumber("Mesh.Algorithm3D", algo_map.get(config.algorithm, 10))
        gmsh.option.setNumber("Mesh.ElementOrder", config.element_order)
        gmsh.option.setNumber("Mesh.CharacteristicLengthMin", config.min_size)
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", config.max_size)

        # Curvature-based local mesh refinement
        if config.curvature_refinement > 0:
            gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 1)
            gmsh.option.setNumber("Mesh.MinimumElementsPerTwoPi", int(1 / config.curvature_refinement))

        # 5. Define Physical Groups (translates to ELSET and NSET in CalculiX)
        # Assign default volume physical group if not specified
        if volume_tags:
            for group_name, vol_ids in volume_tags.items():
                p_tag = gmsh.model.addPhysicalGroup(3, vol_ids)
                gmsh.model.setPhysicalName(3, p_tag, group_name)
        else:
            all_vol_ids = [v[1] for v in volumes]
            p_tag = gmsh.model.addPhysicalGroup(3, all_vol_ids)
            gmsh.model.setPhysicalName(3, p_tag, "EALL")

        # Assign surface physical groups (for boundary conditions & loads)
        if surface_tags:
            for group_name, surf_ids in surface_tags.items():
                p_tag = gmsh.model.addPhysicalGroup(2, surf_ids)
                gmsh.model.setPhysicalName(2, p_tag, group_name)

        # 6. Generate 3D Mesh
        gmsh.model.mesh.generate(3)

        # 7. High-order element optimization (removes negative Jacobians on curved boundaries)
        if config.element_order > 1 and config.optimize_high_order:
            gmsh.model.mesh.optimize("HighOrderElastic")

        # 8. Write mesh file (.inp or .msh)
        os.makedirs(os.path.dirname(os.path.abspath(output_mesh_path)), exist_ok=True)
        gmsh.write(output_mesh_path)

        # Gather mesh statistics
        node_tags, node_coords, _ = gmsh.model.mesh.getNodes()
        elem_types, elem_tags, _ = gmsh.model.mesh.getElements(dim=3)
        total_3d_elements = sum(len(t) for t in elem_tags)

        # 9. Clean up and append CalculiX-compatible *NSET and *SURFACE definitions to .inp file
        surface_face_counts: Dict[str, int] = {}
        nset_node_counts: Dict[str, int] = {}

        if output_mesh_path.endswith(".inp"):
            with open(output_mesh_path, "r", encoding="utf-8") as f:
                content = f.read()

            # Remove duplicate *Heading card written by Gmsh so master deck owns *HEADING
            lines = content.splitlines()
            if lines and lines[0].strip().lower() == "*heading":
                # Skip *Heading and the title line below it
                lines = lines[2:]

            # Filter out 2D surface elements (CPS/CPE/S/T3D) if this is a 3D solid mesh
            if total_3d_elements > 0:
                filtered_lines = []
                skipping_2d = False
                for line in lines:
                    trimmed = line.strip().upper()
                    if trimmed.startswith("*ELEMENT"):
                        if any(k in trimmed for k in ["TYPE=CPS", "TYPE=CPE", "TYPE=S3", "TYPE=S4", "TYPE=S6", "TYPE=S8", "TYPE=T3D"]):
                            skipping_2d = True
                            continue
                        else:
                            skipping_2d = False
                    elif skipping_2d and trimmed.startswith("*"):
                        skipping_2d = False

                    if not skipping_2d:
                        filtered_lines.append(line)
                lines = filtered_lines

            # Read all 3D element IDs and their corner nodes from remaining element definitions in .inp
            valid_elem_ids = set()
            inp_elem_corners: Dict[int, List[int]] = {}
            in_elem = False
            for line in lines:
                trimmed = line.strip()
                if trimmed.startswith("*"):
                    in_elem = trimmed.upper().startswith("*ELEMENT")
                elif in_elem and trimmed:
                    parts = [p.strip() for p in trimmed.split(",") if p.strip()]
                    if len(parts) >= 5:
                        try:
                            eid = int(parts[0])
                            valid_elem_ids.add(eid)
                            inp_elem_corners[eid] = [int(p) for p in parts[1:5]]
                        except ValueError:
                            pass

            # Identify all 2D surface physical group names
            p_groups_2d = gmsh.model.getPhysicalGroups(2)
            surf_group_names = set()
            for dim, p_tag in p_groups_2d:
                p_name = gmsh.model.getPhysicalName(2, p_tag)
                if p_name:
                    surf_group_names.add(p_name)

            # Filter out stale *ELSET blocks whose names are 2D surface physical groups
            # or any ELSET whose element IDs were all removed. Keep *ELSET,ELSET=EALL and volume ELSETs intact.
            filtered_after_elset = []
            idx = 0
            while idx < len(lines):
                line = lines[idx]
                trimmed = line.strip().upper()
                if trimmed.startswith("*ELSET"):
                    elset_name = ""
                    for token in line.split(","):
                        token_clean = token.strip()
                        if token_clean.upper().startswith("ELSET="):
                            elset_name = token_clean[6:].strip()
                        elif token_clean.upper().startswith("NAME="):
                            elset_name = token_clean[5:].strip()

                    elset_lines = [line]
                    j = idx + 1
                    while j < len(lines) and not lines[j].strip().startswith("*"):
                        elset_lines.append(lines[j])
                        j += 1

                    is_eall = (elset_name.upper() == "EALL")
                    is_surf_group = (elset_name in surf_group_names)

                    elset_elem_ids = []
                    for dline in elset_lines[1:]:
                        for tok in dline.split(","):
                            tok_clean = tok.strip()
                            if tok_clean.isdigit():
                                elset_elem_ids.append(int(tok_clean))

                    all_ids_removed = (len(elset_elem_ids) > 0 and set(elset_elem_ids).isdisjoint(valid_elem_ids))

                    if not is_eall and (is_surf_group or all_ids_removed):
                        idx = j
                        continue
                    else:
                        filtered_after_elset.extend(elset_lines)
                        idx = j
                        continue
                else:
                    filtered_after_elset.append(line)
                    idx += 1

            lines = filtered_after_elset

            # Retrieve 3D tetrahedral elements (C3D4: type 4, C3D10: type 11) from Gmsh
            # Use ONLY the 4 corner nodes, i.e. the first 4 nodes of each element in gmsh order
            elem_types, elem_tags, elem_node_tags = gmsh.model.mesh.getElements(dim=3)
            tetra_elements: List[Tuple[int, Tuple[int, ...]]] = []
            for el_type, tags_list, nodes_list in zip(elem_types, elem_tags, elem_node_tags):
                if el_type == 4:
                    num_nodes = 4
                elif el_type == 11:
                    num_nodes = 10
                else:
                    continue
                for k, eid_tag in enumerate(tags_list):
                    eid = int(eid_tag)
                    # Verify element ID appears in .inp
                    if eid in valid_elem_ids and eid in inp_elem_corners:
                        # Corner nodes confirmed from .inp element definition
                        corners = tuple(inp_elem_corners[eid])
                        tetra_elements.append((eid, corners))
                    elif eid in valid_elem_ids:
                        conn = nodes_list[k * num_nodes : (k + 1) * num_nodes]
                        corners = tuple(int(n) for n in conn[:4])
                        tetra_elements.append((eid, corners))

            # Fallback if getElements didn't populate list but inp elements exist
            if not tetra_elements and inp_elem_corners:
                tetra_elements = [(eid, tuple(corners)) for eid, corners in inp_elem_corners.items()]

            # CalculiX/Abaqus tetra face numbering by corner nodes:
            # S1 = (1,2,3), S2 = (1,4,2), S3 = (2,4,3), S4 = (3,4,1)
            # In 0-based indexing:
            face_defs = [
                ("S1", (0, 1, 2)),
                ("S2", (0, 3, 1)),
                ("S3", (1, 3, 2)),
                ("S4", (2, 3, 0)),
            ]

            surface_blocks = []

            # Append NALL and physical group node sets
            content = "\n".join(lines)
            nset_blocks = [content, "\n*NSET, NSET=NALL, GENERATE", f"1, {len(node_tags)}, 1\n"]

            # Export NSET and *SURFACE for all 2D surface physical groups
            for dim, p_tag in p_groups_2d:
                p_name = gmsh.model.getPhysicalName(2, p_tag)
                if p_name:
                    nodes_in_grp, _ = gmsh.model.mesh.getNodesForPhysicalGroup(2, p_tag)
                    grp_node_set = set(int(n) for n in nodes_in_grp)
                    nset_node_counts[p_name] = len(nodes_in_grp)

                    if len(nodes_in_grp) > 0:
                        nset_blocks.append(f"*NSET, NSET={p_name}")
                        for k in range(0, len(nodes_in_grp), 10):
                            chunk = nodes_in_grp[k : k + 10]
                            nset_blocks.append(", ".join(str(n) for n in chunk) + ",")

                    # Build element-face surface from 3D elements
                    faces_for_grp = []
                    for eid, corners in tetra_elements:
                        for s_label, (c1, c2, c3) in face_defs:
                            if {corners[c1], corners[c2], corners[c3]}.issubset(grp_node_set):
                                faces_for_grp.append((eid, s_label))

                    surface_face_counts[p_name] = len(faces_for_grp)
                    if faces_for_grp:
                        surface_blocks.append(f"*SURFACE, NAME={p_name}_SURF, TYPE=ELEMENT")
                        for eid, s_label in faces_for_grp:
                            surface_blocks.append(f"{eid}, {s_label}")

            if surface_blocks:
                nset_blocks.append("\n" + "\n".join(surface_blocks))

            with open(output_mesh_path, "w", encoding="utf-8") as f:
                f.write("\n".join(nset_blocks))

        stats = {
            "num_nodes": len(node_tags),
            "num_3d_elements": total_3d_elements,
            "element_order": config.element_order,
            "output_file": output_mesh_path,
            "surface_face_counts": surface_face_counts,
            "nset_node_counts": nset_node_counts,
        }

        return stats


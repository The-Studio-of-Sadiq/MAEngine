"""
CalculiX Input Deck (.inp) Generator
Compiles Pydantic SimulationProject schemas into Abaqus-compliant CalculiX decks via Jinja2.
"""

import os
from typing import Dict, Any, List, Optional
import jinja2
from maengine.schema.model import SimulationProject, StepType


class CalculixDeckGenerator:
    def __init__(self, templates_dir: Optional[str] = None):
        base_dir = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
        default_dir = os.path.join(base_dir, "templates", "calculix")
        marketplace_dir = os.path.join(base_dir, "templates", "marketplace")

        search_dirs = [default_dir]
        if templates_dir and os.path.exists(templates_dir) and templates_dir not in search_dirs:
            search_dirs.insert(0, templates_dir)
        if os.path.exists(marketplace_dir):
            search_dirs.append(marketplace_dir)

        self.templates_dir = templates_dir or default_dir
        self.env = jinja2.Environment(
            loader=jinja2.FileSystemLoader(search_dirs),
            trim_blocks=True,
            lstrip_blocks=True,
        )

    def generate_deck(
        self,
        project: SimulationProject,
        mesh_file_rel_path: str,
        output_inp_path: str,
        default_material: Optional[str] = None,
        custom_template: Optional[str] = None,
        nset_node_counts: Optional[Dict[str, int]] = None,
    ) -> str:
        """
        Renders the complete CalculiX .inp file.
        """
        # Determine sections: map element sets to materials
        mat_name = default_material or (project.materials[0].name if project.materials else "DEFAULT_STEEL")
        sections = [
            {"elset": "EALL", "material": mat_name}
        ]

        # Select template based on step type or custom override
        if custom_template:
            template_name = custom_template
        elif project.steps:
            first_step = project.steps[0]
            if first_step.type == StepType.MODAL_FREQUENCY:
                template_name = "modal.inp.j2"
            elif first_step.type == StepType.STEADY_HEAT_TRANSFER:
                template_name = "thermal.inp.j2"
            else:
                template_name = "static.inp.j2"
        else:
            template_name = "static.inp.j2"

        template = self.env.get_template(template_name)

        # *CLOAD applies its value to EVERY node of the set, so force loads are divided by the
        # set's node count. A missing count must fail loudly: silently using 1 would multiply
        # the applied force by the number of nodes.
        safe_node_counts = dict(nset_node_counts or {})
        for step in project.steps:
            for load in step.loads:
                if load.type.value == "force" and safe_node_counts.get(load.target_set, 0) <= 0:
                    raise ValueError(
                        f"Force load '{load.name}' targets node set '{load.target_set}', "
                        "but its node count is unknown or zero; cannot distribute the force."
                    )

        rendered_deck = template.render(
            project=project,
            mesh_file=mesh_file_rel_path,
            sections=sections,
            nset_node_counts=safe_node_counts,
        )

        os.makedirs(os.path.dirname(os.path.abspath(output_inp_path)), exist_ok=True)
        with open(output_inp_path, "w", encoding="utf-8") as f:
            f.write(rendered_deck)

        return output_inp_path

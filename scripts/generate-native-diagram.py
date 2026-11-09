"""Regenerate the native vehicle outline from the shared web/PDF geometry."""
import json
import re
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parent.parent
geometry = json.loads((root / "shared/vehicle-diagram.json").read_text())
output = [
    "// Generated from shared/vehicle-diagram.json. Do not edit the geometry independently.",
    "import SwiftUI",
    "func vehicleDiagramPath() -> Path {",
    "    var p = Path()",
]


def point(x, y):
    return f"CGPoint(x: {x}, y: {y})"


for path in geometry["paths"]:
    tokens = re.findall(r"[A-Za-z]|-?\d+(?:\.\d+)?", path)
    index = 0
    current = (0, 0)
    start = current
    control = None
    while index < len(tokens):
        command = tokens[index]
        index += 1
        if command not in ("M", "L", "Q", "T", "Z"):
            raise ValueError(f"Unsupported diagram command: {command}")
        if command == "Z":
            output.append("    p.closeSubpath()")
            current = start
            control = None
            continue
        count = 4 if command == "Q" else 2
        values = list(map(float, tokens[index:index + count]))
        index += count
        if command == "M":
            output.append(f"    p.move(to: {point(*values)})")
            current = tuple(values)
            start = current
            control = None
        elif command == "L":
            output.append(f"    p.addLine(to: {point(*values)})")
            current = tuple(values)
            control = None
        elif command == "Q":
            output.append(f"    p.addQuadCurve(to: {point(*values[2:])}, control: {point(*values[:2])})")
            current = tuple(values[2:])
            control = tuple(values[:2])
        else:
            reflected = (2 * current[0] - control[0], 2 * current[1] - control[1]) if control else current
            output.append(f"    p.addQuadCurve(to: {point(*values)}, control: {point(*reflected)})")
            current = tuple(values)
            control = reflected
for x, y, radius in geometry["circles"]:
    output.append(f"    p.addEllipse(in: CGRect(x: {x-radius}, y: {y-radius}, width: {2*radius}, height: {2*radius}))")
output.extend(["    return p", "}"])
target = root / "ios/FleetCheckout/VehicleDiagram.swift"
target.write_text("\n".join(output) + "\n")
subprocess.run(["xcrun", "swift-format", "format", "--in-place", str(target)], check=True)

"""Makes a turnaround sheet of a finished model, for SketchCollab's review loop.

Run:  blender -b model.blend --python agent-tools/turnaround.py -- <output folder> ["Title for the sheet"]

Writes <output folder>/turnaround.png: the model from 8 sides (every 45 degrees, at the same scale, level,
orthographic, so the views line up), then from straight above and straight below. Ten labelled views
in 2 rows of 5, on white. The .blend is never saved.
"""
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = Path(args[0]) if args else Path(bpy.data.filepath).parent / "turnaround"
TITLE = args[1] if len(args) > 1 else ""
OUT.mkdir(parents=True, exist_ok=True)
CELL_W, CELL_H = 800, 1000
VIEWS = [("Front", 0), ("Front 3/4 (45°)", 45), ("Side (90°)", 90), ("Back 3/4 (135°)", 135), ("Back (180°)", 180),
         ("Back 3/4 (225°)", 225), ("Side (270°)", 270), ("Front 3/4 (315°)", 315)]

scene = bpy.context.scene
for c in [o for o in scene.objects if o.type == "CAMERA"]:
    c.hide_render = True

# ---------------------------------------------------------------- what to show, and how big it is
models = [o for o in scene.objects if o.type in {"MESH", "CURVE", "SURFACE", "META", "FONT"} and not o.hide_render and o.visible_get()]
if not models:
    sys.exit("turnaround: nothing to render")
dg = bpy.context.evaluated_depsgraph_get()
pts = [o.matrix_world @ Vector(c) for o in models for c in o.evaluated_get(dg).bound_box]
lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
centre = (lo + hi) / 2
radius = max(math.hypot(p.x - centre.x, p.y - centre.y) for p in pts)   # widest it gets as it turns
height = hi.z - lo.z

# Turn the model, not the camera, so the light falls the same way on every side.
pivot = bpy.data.objects.new("Turntable", None)
scene.collection.objects.link(pivot)
pivot.location = (centre.x, centre.y, 0)
for o in models:
    if o.parent is None:
        mw = o.matrix_world.copy()
        o.parent = pivot
        o.matrix_world = mw

if not any(o.type == "LIGHT" for o in scene.objects):
    for name, loc, energy in (("Key", (-3, -4, 4), 600), ("Fill", (4, -3, 2), 200), ("Rim", (1, 4, 3), 300)):
        ld = bpy.data.lights.new(name, "AREA")
        ld.energy, ld.size = energy, 3
        lo_ = bpy.data.objects.new(name, ld)
        scene.collection.objects.link(lo_)
        lo_.location = centre + Vector(loc)
        lo_.rotation_euler = (centre - lo_.location).to_track_quat("-Z", "Y").to_euler()
below = bpy.data.lights.new("Light from below", "AREA")
below.energy, below.size = 400, 4
below_o = bpy.data.objects.new("Light from below", below)
scene.collection.objects.link(below_o)
below_o.location = centre - Vector((0, 0, height + 2))
below_o.rotation_euler = (math.radians(180), 0, 0)   # pointing up
below_o.hide_render = True

# ---------------------------------------------------------------- camera and the label under each view
cam_data = bpy.data.cameras.new("Turnaround camera")
cam_data.type = "ORTHO"
cam_data.clip_end = 1000
cam = bpy.data.objects.new("Turnaround camera", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

label_mat = bpy.data.materials.new("Label")
label_mat.use_nodes = True
label_mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.02, 0.02, 0.03, 1)
label_mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 1
txt_data = bpy.data.curves.new("Label", "FONT")
txt_data.align_x = "CENTER"
label = bpy.data.objects.new("Label", txt_data)
scene.collection.objects.link(label)
label.data.materials.append(label_mat)
label.parent = cam

r = scene.render
r.resolution_x, r.resolution_y, r.resolution_percentage = CELL_W, CELL_H, 100
r.film_transparent = True
r.image_settings.file_format = "PNG"
r.image_settings.color_mode = "RGBA"
scene.view_settings.view_transform = "Standard"


def frame(scale, text):
    """Fits the camera's view, and puts the label near the bottom of the picture."""
    cam_data.ortho_scale = scale
    txt_data.body = text
    txt_data.size = scale * 0.035
    label.location = (0, -scale / 2 + scale * 0.035, -1)


def render(i, text):
    frame(cam_data.ortho_scale, text)
    r.filepath = str(OUT / f"_view{i:02d}.png")
    bpy.ops.render.render(write_still=True)
    return OUT / f"_view{i:02d}.png"


side_scale = max(height / 0.82, 2 * radius / 0.8 / 0.82)   # room around it, and for the label
files = []
for i, (name, deg) in enumerate(VIEWS):
    pivot.rotation_euler = (0, 0, -math.radians(deg))      # turning the model one way = walking round it the other
    cam.location = (centre.x, centre.y - (radius + 50), centre.z)
    cam.rotation_euler = (math.radians(90), 0, 0)
    frame(side_scale, name)
    files.append(render(i, name))

pivot.rotation_euler = (0, 0, 0)
top_scale = 2 * max(hi.x - lo.x, hi.y - lo.y, 2 * radius) / 1.25   # the whole footprint, with room for the label
cam.location = (centre.x, centre.y, hi.z + 50)
cam.rotation_euler = (0, 0, 0)                               # looking down, front of the model at the bottom
frame(top_scale, "Top (front at the bottom)")
files.append(render(8, "Top (front at the bottom)"))
below_o.hide_render = False
cam.location = (centre.x, centre.y, lo.z - 50)
cam.rotation_euler = (math.radians(180), 0, 0)               # looking up, front of the model at the top
frame(top_scale, "Bottom (front at the top)")
files.append(render(9, "Bottom (front at the top)"))

# ---------------------------------------------------------------- one sheet: 2 rows of 5 on white
HEAD = 140 if TITLE else 0
sheet = np.ones((2 * CELL_H + HEAD, 5 * CELL_W, 4), dtype=np.float32)
for i, f in enumerate(files):
    im = bpy.data.images.load(str(f))
    px = np.empty(CELL_W * CELL_H * 4, dtype=np.float32)
    im.pixels.foreach_get(px)
    px = px.reshape(CELL_H, CELL_W, 4)                       # rows run bottom to top
    a = px[..., 3:4]
    rgb = px[..., :3] * a + (1 - a)                          # onto white
    row, col = divmod(i, 5)
    y0 = (1 - row) * CELL_H                                  # the first row goes at the top
    sheet[y0:y0 + CELL_H, col * CELL_W:(col + 1) * CELL_W, :3] = rgb
    bpy.data.images.remove(im)
    f.unlink()
# Thin grey lines between the views.
for col in range(1, 5):
    sheet[:2 * CELL_H, col * CELL_W - 1:col * CELL_W + 1, :3] = 0.85
sheet[CELL_H - 1:CELL_H + 1, :, :3] = 0.85

if TITLE:   # the title is rendered as text on its own, then laid along the top
    for o in models:
        o.hide_render = True
    below_o.hide_render = True
    r.resolution_x, r.resolution_y = 5 * CELL_W, HEAD
    cam.location, cam.rotation_euler = (0, 0, 500), (0, 0, 0)
    cam_data.ortho_scale = 10
    txt_data.body, txt_data.align_x, txt_data.size = TITLE, "LEFT", 0.12
    label.location = (-4.85, -0.04, -1)
    r.filepath = str(OUT / "_title.png")
    bpy.ops.render.render(write_still=True)
    im = bpy.data.images.load(str(OUT / "_title.png"))
    px = np.empty(5 * CELL_W * HEAD * 4, dtype=np.float32)
    im.pixels.foreach_get(px)
    px = px.reshape(HEAD, 5 * CELL_W, 4)
    sheet[2 * CELL_H:, :, :3] = px[..., :3] * px[..., 3:4] + (1 - px[..., 3:4])
    bpy.data.images.remove(im)
    (OUT / "_title.png").unlink()

out = bpy.data.images.new("Turnaround sheet", 5 * CELL_W, 2 * CELL_H + HEAD, alpha=False)
out.pixels.foreach_set(sheet.ravel())
out.filepath_raw = str(OUT / "turnaround.png")
out.file_format = "PNG"
out.save()
print("TURNAROUND", OUT / "turnaround.png")

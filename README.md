# SketchCollab

Draw and talk at the same time. SketchCollab writes down what you say, records your voice, and
remembers what you drew while you were saying it. Then it hands it all to Claude.

## Start it

Double-click **SketchCollab** on your desktop (or `start.bat` in this folder). A small minimised window
starts the app's local server, and the app opens in its own Chrome window. The first time you press
**Start talking**, Chrome asks to use the microphone: choose **Allow**.

To stop it, close the app window and the minimised "SketchCollab (close to stop)" window.

## The screen

- **Top:** Start talking, the sketch's name, Copy picture, Copy words, **Save**, **Send to Claude**, New, and
  the theme button (Auto / Light / Dark).
- **Left:** the tools, the Import pictures button, and your two colours (click one to change it, ⇄ swaps them).
- **Above the drawing:** the settings for the tool you're using.
- **Right:** **Layers**, and **What you said**. Each line has a ▶ button that plays back that part, with the
  drawing redrawing itself and your recorded voice. The ▶ at the top plays the whole session.
- **Bottom right of the drawing:** the drawing size and paper (click it), and zoom − / + / Fit.

## Tools (shortcut in brackets)

| Tool | What it does |
|---|---|
| Move (V) | Click anything to select it, Shift-click to add, or drag a box. Drag to move; handles resize (Shift for a free resize). Arrow keys nudge. Bring to front, Send to back, Move to layer, Duplicate, Delete. |
| Marquee (M) | Rectangle or ellipse selection on the active layer. Anything partly inside, even part of a photo, is cut out when you move or delete it. |
| Lasso (L) | Draw around what you want on the active layer. Works the same as Marquee. |
| Quick select (W) | Click a drawing to grab the whole connected piece. Click a photo to select an area of similar colour (the magic wand). |
| Brush (B) | Pencil, Ink pen, Soft brush, Marker, Highlighter, Airbrush. Size, opacity, softness, flow, smoothing, and pen pressure for size or opacity. [ and ] change the size. Alt-click picks a colour. |
| Eraser (E) | Rubs out on the active layer only. |
| Paint bucket (G) | Fills an area with your main colour. |
| Gradient (Shift+G) | Drag from your main colour to your second colour. Fills the selection, or the whole drawing if nothing is selected. Linear or radial. |
| Shapes (U) | Rectangle, ellipse, line and arrow, with an optional fill. Shift makes it square, round or straight. |
| Text (T) | Click and type. Click away, or press Ctrl+Enter, to finish. Click existing text to edit it. |
| Eyedropper (I) | Picks a colour from the drawing. |
| Point (P) | Press and drag to the thing you mean. With a mouse or pen you can also just rest on something for half a second while you're talking: a pink ring shows it was noted. On a phone or tablet, use this tool. |
| Hand (H) | Moves around the drawing. Space or the middle mouse button do the same from any tool. |
| Zoom (Z) | Click to zoom in, Alt-click to zoom out. The mouse wheel zooms too. Ctrl+0 fits the drawing, Ctrl+1 shows it at 100%. |

Other keys: Ctrl+Z undo, Ctrl+Y redo, Ctrl+C / Ctrl+X / Ctrl+V, Ctrl+A select all on the layer,
Ctrl+D deselect, Delete, X swap colours, D default colours, R start or stop talking.

## Pictures

Import pictures with the button on the left, paste them (for example a screen snip, Win+Shift+S then
Ctrl+V), or drag them in. JPG, PNG, GIF (first frame), WebP, BMP, SVG and AVIF all work. Each picture
gets its own layer, so you can draw over it on another layer. iPhone HEIC photos don't open in Chrome:
save them as JPG first.

## Layers

New layer (+), move it up or down, delete it. Each layer has an eye (show/hide) and a lock. Click a layer
to draw on it, and double-click to rename it. The active layer has an opacity slider.

## Talking

1. Press **Start talking** (or R) and explain while you draw. Your words show up on the right.
2. A word wrong? Click the line and fix it. You can also type notes (Win+H dictates into the note box).
3. Press ▶ on any line to see and hear that part again.

## Save, or Send to Claude

- **Send to Claude** saves the session and tells Claude. If your chat with Claude is open, Claude picks it
  up within a few seconds and replies, without you typing anything. If the chat isn't open, the session is
  still saved: tell Claude *"look at my latest sketch session"* next time.
- **Save** just saves it.
- **Copy picture** and **Copy words** put the session on the clipboard, for pasting into any chat (for
  example the Claude phone app).

Each save makes a folder in `sessions\`, named by date and time plus the name you gave it:

| File | What it is |
|---|---|
| `transcript.md` | The layers, then every moment: what you said, what you did on the drawing while saying it, and where. Then an exact timeline |
| `moments\01.png` ... | One picture per moment. What changed glows yellow, the rest is faded, pointing is a pink arrow or ring |
| `storyboard.png` | The final drawing plus every moment on one page |
| `final.png` | The finished drawing |
| `layers\01.png` ... | Each layer on its own, bottom layer first |
| `assets\` | The pictures you brought in, plus fills and cut-out shapes |
| `audio\` | Your voice, one file per stretch of talking |
| `session.json` | Everything, with timings, so the session can be replayed |

## Good to know

- Speech-to-text is Chrome's (or Edge's) built-in one. It needs the internet, and your voice is sent to
  Google (Microsoft in Edge) to be turned into text. Your voice recording and everything else stay on this
  computer. Firefox doesn't have speech-to-text.
- The timer only runs while you're talking, so moments line up with your words. Drawing done before you
  start talking is kept as its own moment.
- If the tab closes by accident, the app offers to pick up the last sketch when it opens again.
- The server only listens on this computer (`127.0.0.1`), and only accepts saves from the app itself.

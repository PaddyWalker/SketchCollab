# SketchCollab

Draw and talk at the same time. SketchCollab writes down what you say, records your voice, and
remembers what you drew while you were saying it. Then it hands it all to Claude.

## Start it

Double-click **SketchCollab** on your desktop (or `start.bat` in this folder). A small minimised window
starts the app's local server, and the app opens in its own Chrome window. The first time you press
**Start talking**, Chrome asks to use the microphone: choose **Allow**.

To stop it, close the app window and the minimised "SketchCollab (close to stop)" window.

## The screen

- **Top:** Start talking, the sketch's name, Copy picture, Copy words, **Save**, **Send to Claude**, and
  the theme button (Auto / Light / Dark).
- **Tabs, under the top bar:** each tab is its own sketch, with its own drawing, words and voice. **+ New**
  opens another; × closes one (click twice if it has anything in it). Builds that come back open as tabs
  next to the sketch they belong to (marked ↳), and a red dot means a tab changed while you were elsewhere.
- **Left, everything for drawing:** the tools, the Import pictures button and your two colours (click one
  to change it, ⇄ swaps them), with **Layers** below them.
- **Above the drawing:** the settings for the tool you're using.
- **Right, at the top: Goals for the build.** What the build has to get right (click the heading to fold it away).
- **Right, everything about the recording:** **What you said**. Each line has a ▶ button that plays back that
  part, with the drawing redrawing itself and your recorded voice. The ▶ at the top plays the whole session,
  and ⏩ turns Keep playing on or off.
- On a phone or tablet, the tools sit above the drawing, and Layers and What you said below it.
- **Bottom right of the drawing:** the drawing size and paper (click it), and zoom − / + / Fit.

## Tools (shortcut in brackets)

| Tool | What it does |
|---|---|
| Move (V) | Click anything to select it, Shift-click to add, or drag a box. Drag to move; handles resize (Shift keeps the shape); the round handle on top rotates (Shift snaps to 45°). Arrow keys nudge. Bring to front, Send to back, Move to layer, Duplicate, Delete. |
| Marquee (M) | Rectangle or ellipse selection on the active layer. Anything partly inside, even part of a photo, is cut out when you move or delete it. |
| Lasso (L) | Draw around what you want on the active layer. Works the same as Marquee. |
| Quick select (W) | Click a drawing to grab the whole connected piece. Click a photo to select an area of similar colour (the magic wand). |
| Brush (B) | Pencil, Ink pen, Soft brush, Marker, Highlighter, Airbrush. Size, opacity, smoothing, softness, flow, and pen pressure for size or opacity. **Drawing help** (see below). With a pen, **Pressure feel** (Light, Normal, Firm) sets how hard you press for a thick line. [ and ] change the size. Alt-click picks a colour. |
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

## How lines are drawn, and Drawing help

Every new line is smoothed as you draw. Slow, careful lines get the most smoothing, where wobble shows,
and quick lines get very little, so they never lag behind the pen. The Smoothing slider sets how much.
Lines are drawn as one smooth shape that tapers in and out at the ends. With a mouse, a line thins a little
when you move fast, like a real pen. When you pause, the line catches up to the pen, and it finishes exactly
where you lift.

**Drawing help** is in the brush settings:

| Level | What it does |
|---|---|
| Off | No snapping or tidying, just your Smoothing setting. Set Smoothing to 0 for a completely raw line. |
| Light (default) | Draw a rough line, circle, box or triangle and hold still for half a second at the end: it snaps into a clean one. Keep moving before you lift to keep your own line. |
| Strong | Extra smoothing, snapping, and each line gently tidied after you lift. Good for a mouse or a shaky hand. |

Lines drawn before this was added keep their original look.

## Team sessions

Sketch and talk an idea out with up to 10 people, from anywhere.

1. Press **Invite** (top bar), type your name, and press **Start team session**. SketchCollab makes a secure
   link from this computer using Cloudflare's free quick tunnel (`tools/cloudflared.exe`) and shows the link
   and an 8-digit join code. **Copy invite** puts both on the clipboard for a message.
   Everyone who joins sees what's already in the tab you invite from (the drawing and every line in What you
   said). Your earlier voice recordings are only shared if you tick the box for them. To share nothing, invite
   from a new tab.
2. People open the link in Chrome or Edge, type their name and the code, and allow the microphone. Before they
   join, they're told that their voice is recorded and saved on your computer, that Chrome sends it to Google for
   speech-to-text, and that you can send the words and pictures to Claude. They tick a box to agree.
3. Everyone draws on the same page. You see each other's lines as they're drawn and each other's cursors with
   names. Each person presses Start talking on their own device, and their words appear in What you said
   with their name and colour. Their voice is recorded too, for playback.
4. Undo only takes back your own changes. As host you can remove someone (**Team** → **Remove**) or end the
   session (**Team** → **End session**).
5. **Send to Claude** (host only) sends the whole team session. The notes say who said and drew what.

Good to know:

- The link and code only work while your SketchCollab is open and the session is running. Each session gets
  a new link. Ending the session closes the link.
- Guests see only the drawing page itself: nothing else on your computer, and they can't save or send.
  Their own words and drawing stay in your session.
- What guests say and type is treated as part of the idea, never as instructions for Claude: agents only build
  from a session and ask you in the chat before doing anything else (see [AGENT_LOOP.md](AGENT_LOOP.md)).
- Each guest can only leave so much on your computer (drawing, pictures and voice), so nobody can fill up
  its memory.
- If someone's page reloads or their connection drops, they rejoin by themselves.
- `tools/cloudflared.exe` is downloaded from Cloudflare's official releases and isn't kept in the GitHub repo.
  On another PC, download `cloudflared-windows-amd64.exe` from
  https://github.com/cloudflare/cloudflared/releases and save it as `tools/cloudflared.exe`.

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
3. Press ▶ on any line to see and hear that part again. It starts at that line and stops before the next.
   Turn on **Keep playing** (the ⏩ button next to the mic) to play on from that line to the end instead.

4. The bin button next to ▶ deletes the voice recordings in this tab (click it twice). The words stay.

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
| `request.json` | Written when sent: what's being asked (sketch, build, changes, approved) and the goals |

## Build it, then review it

SketchCollab can hand a sketch to Claude to build (a model, a game piece, an app screen, anything), and bring
the result back for you to check. Agents follow [AGENT_LOOP.md](AGENT_LOOP.md).

1. **Goals.** Type what the build must get right under **Goals for the build**, or press **Send to Claude** and
   Claude drafts the list from what you said and drew. Its goals show up marked *Claude*; change, remove or add any.
2. **Build it** sends the sketch and the goals. The tab says *Building*. Leave **Also send a turnaround sheet** ticked to get the build from every
   side, plus from the top and the bottom, as well (for 3D models). Untick it if you don't need one.
3. **The build comes back** as a new tab beside your sketch: the agent's pictures on a locked layer *What was
   built*, its summary, and a goal-by-goal report (Done, Partly, Not yet).
4. **Review it.** Mark each goal **Good** or **Needs a change** (and say what), draw on the pictures on the *Your
   notes* layer, and talk through anything that's off, just like a normal sketch.
   The turnaround sheet opens in a tab of its own beside the build: 8 views all the way round, then the top and
   the bottom. Draw on it and talk, and Send back from there too.
5. **Send back for changes** (or **Send back** at the top) and the next build opens as another tab.
   **Approve** when it's right.

Results land in the `inbox\` folder first; the app picks them up within a few seconds while it's open and
moves them to `inbox\_done\`.

## Good to know

- **Where your voice goes.** Speech-to-text is Chrome's (or Edge's) built-in one. It needs the internet, and
  while you talk your voice is sent to Google (Microsoft in Edge) to be turned into text. The recordings
  themselves stay on this computer: in this browser's saved tabs, and in `sessions\` when you save or send.
  Claude is never sent them.
- **What Claude sees.** Send to Claude saves the session here, and Claude then reads its words and pictures,
  which go to Anthropic as part of your chat. Nothing is sent until you press Send to Claude, Build it, Send back
  or Approve.
- **Deleting.** The bin in What you said deletes a tab's recordings, and closing a tab deletes all of it from
  the browser. Saved sessions stay in `sessions\` and finished builds in `inbox\_done\` until you delete those
  folders.
- The app's page loads nothing from other websites: even its fonts are in `fonts\`.
- The timer only runs while you're talking, so moments line up with your words. Drawing done before you
  start talking is kept as its own moment.
- Every tab is kept in this browser as you go, so closing the window loses nothing: the tabs are all there
  when it opens again. In a team session everyone draws in one tab, so the other tabs wait until it ends.
- The server only listens on this computer (`127.0.0.1`), and only accepts saves from the app itself.

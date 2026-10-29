# The build and review loop: instructions for agents

SketchCollab passes a sketch to Claude, an agent builds it, and the results come back into the app as a review tab.
This file is for whichever agent does the building: read it before starting.

## 1. What arrives

Every Send from the app writes a session folder `sessions/<name>/` and adds a line to `sessions/_sent.log`:

```
2026-10-28T21:28:46 2026-10-28_212824_red-ball build
```

The last word is the request kind. The details are in `sessions/<name>/request.json`:

| kind | What it means | What to do |
|---|---|---|
| `sketch` | A new idea, sent with Send to Claude. | Read the session, then draft a goal list (step 2). Don't build yet. |
| `build` | The goals are confirmed (`request.goals`). | Build it (step 3). |
| `changes` | A review with things to fix. `build_of` is the original session, `goals` has each goal's verdict and comment. | Read the review session, fix what is marked, and send a new build (step 3, next `round`). |
| `approved` | The build is right. | Finish up and save the work properly; nothing goes back to the app. |

What to read in the session folder: `transcript.md` first (words, moments and goals in order), then `storyboard.png`, `final.png`
and the `moments/` pictures. Match what was said with what was drawn by order: each moment pairs words with the drawing done
while saying them. In a review, the layer "What was built" holds your own pictures, and marks on "Your notes" point at what to change.

## 2. Drafting goals (for a `sketch`)

Write `inbox/<id>/item.json`, where `<id>` is a new folder name of letters, digits, `-` and `_`:

```json
{ "kind": "goals", "session": "<the session name>", "goals": ["A bouncy red ball", "Sits on a snowy mountain"] }
```

Each goal is one short, checkable sentence about the finished thing, in Paddy's own words where possible. The app adds
them to that sketch's Goals panel (keeping any he wrote himself) and he presses Build it, which sends a `build` request.

## 3. Sending a build back (for a `build` or `changes`)

Build the thing, then make pictures of it: renders, screenshots or photos (PNG, JPG or WebP; up to 12; about 1000 px wide is plenty).
Put them in `inbox/<id>/` with an `item.json`:

```json
{
  "kind": "review",
  "session": "<the session name the request came from>",
  "round": 1,
  "title": "Build 1 of Red ball",
  "summary": "Two or three sentences on what was built and how.",
  "built": ["One line per part that was made"],
  "goals": [
    { "text": "A bouncy red ball", "status": "partly", "note": "Red and glossy, but it doesn't bounce yet." },
    { "text": "Sits on a snowy mountain", "status": "done", "note": "On the snow cap at the peak." }
  ],
  "images": [ { "file": "front.png", "caption": "Front view" } ],
  "notes": "Where the files are, and anything Paddy should know."
}
```

- `session` is the session the request came from (for `changes`, the review session), so the new tab opens beside the right sketch.
- `round` counts builds of the same sketch: 1, then 2 after the first changes, and so on.
- `status` is `done`, `partly` or `not yet`, and `note` says honestly what is and isn't there. Don't mark something done that wasn't checked.
- Pictures must be inside the item's own folder. Write `item.json` last, so the app never picks up a half-written item.

The app checks the inbox every few seconds while it is open, opens the build as a new tab and moves the item to `inbox/_done/`.

## 4. Keeping it automatic

The goal is for Paddy only to sketch, confirm goals and review. So: draft goals without asking, build as soon as `build` arrives,
and work from the review's verdicts, comments, drawing and words without asking again unless something truly can't be decided.
When a build can't be checked against a goal (it needs a real device, for example), say so in that goal's `note`.

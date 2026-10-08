# SmartQ phone widgets

Home-screen widgets that show the ticket each window is serving now and how
many people are waiting, for Cashier and Registrar.

Both widgets read one public endpoint:

    <server>/display/widget.json

It returns ticket numbers only, never names. Example:

    {
      "updated": "2026-10-04T02:41:09.000Z",
      "cashier":   { "waiting": 4, "windows": [{ "label": "Cashier 1", "status": "open", "serving": "C-012" }] },
      "registrar": { "waiting": 2, "windows": [ ... two windows ... ] },
      "cashier_waiting": 4, "cashier_1": "C-012",
      "registrar_waiting": 2, "registrar_1": "R-007", "registrar_2": "—"
    }

`—` means the window is not serving anyone right now.

## Which address to use

- **Testing at school/home:** the phone must be on the same Wi-Fi as the PC
  running `npm start`. Use the PC's LAN IP, which `npm start` prints when it
  starts (e.g. `http://192.168.1.20:3000`). `localhost` does NOT work from a phone.
- **Online:** use the Render URL, e.g. `https://smartq-licom.onrender.com`.
  (The free Render plan sleeps when idle, so the first refresh can be slow.)

Check the address first: open `<server>/display/widget.json` in the phone's
browser. You should see the JSON above.

---

## iPhone: Scriptable

1. Install **Scriptable** (free) from the App Store.
2. Open it, tap **+**, and paste in all of `smartq-scriptable.js`.
3. The `SERVER` line at the top already points at the live site; change it only
   to test on your own Wi-Fi. Name the script
   `SmartQ` (tap the title), then tap **Done**.
4. Tap the script once to preview it. A medium widget should appear.
5. On the home screen, long-press > **Edit** > **Add Widget** > **Scriptable**
   > choose **Medium** (or Small) > **Add Widget**.
6. Long-press the new widget > **Edit Widget** > **Script** > `SmartQ`.

Tapping the widget opens the Cashier display board.

## Android: KWGT

1. Install **KWGT Kustom Widget Maker** from the Play Store.
2. On the home screen, long-press > **Widgets** > **KWGT** > drag a
   **4x2** widget onto the screen. Tap it to open the editor.
3. Pick **Empty widget**. In the **Items** tab, tap **+** > **Text** and set its text to:

       SmartQ · Now Serving

4. Add one Text item per number below. Tap the text field, choose the
   formula option and paste the formula. Replace `SERVER` with your address.

   | Shows | Formula |
   |---|---|
   | Cashier window 1 | `$wg("SERVER/display/widget.json", json, ".cashier_1")$` |
   | Cashier waiting  | `$wg("SERVER/display/widget.json", json, ".cashier_waiting")$ waiting` |
   | Registrar window 1 | `$wg("SERVER/display/widget.json", json, ".registrar_1")$` |
   | Registrar window 2 | `$wg("SERVER/display/widget.json", json, ".registrar_2")$` |
   | Registrar waiting  | `$wg("SERVER/display/widget.json", json, ".registrar_waiting")$ waiting` |
   | Last updated | `$df(hh:mma)$` |

   Example with a real address:
   `$wg("http://192.168.1.20:3000/display/widget.json", json, ".cashier_1")$`

5. Style the items however you like. A large bold font for the ticket
   numbers and a small grey one for labels reads well. Put the Cashier items
   in an **Overlap/Stack group** on the left and Registrar on the right.
6. Tap the **save** icon at the top. The widget updates on the home screen.

If you add more windows under Admin > Service Windows, they show up as
`cashier_2`, `registrar_3` and so on, so add matching Text items.

## How fresh is it?

Phones refresh widgets on their own schedule, not every second. iOS
usually refreshes every 5–15 minutes. KWGT re-downloads at its
configured refresh interval. Both are fine for "is the line moving?",
but the TV display board is still the live view. Tap the widget to open the
full board.

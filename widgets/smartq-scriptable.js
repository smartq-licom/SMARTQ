// SmartQ "Now Serving" widget for iPhone (Scriptable app).
// Setup steps: widgets/README.md
//
// SERVER is the live SmartQ site. For a test on the same Wi-Fi as the PC,
// use the PC's LAN IP instead (e.g. http://192.168.1.20:3000).
const SERVER = 'https://smartq-licom.onrender.com';

const BRAND = new Color('#2185D5');   // SmartQ blue
const INK   = Color.dynamic(new Color('#0f172a'), new Color('#f8fafc'));
const SOFT  = Color.dynamic(new Color('#64748b'), new Color('#94a3b8'));
const BG    = Color.dynamic(new Color('#ffffff'), new Color('#0b1220'));

async function load() {
  const req = new Request(SERVER + '/display/widget.json');
  req.timeoutInterval = 10;
  return req.loadJSON();
}

function addDept(stack, title, dept, compact) {
  const col = stack.addStack();
  col.layoutVertically();

  const head = col.addText(title.toUpperCase());
  head.font = Font.boldSystemFont(10);
  head.textColor = BRAND;
  col.addSpacer(2);

  for (const w of dept.windows) {
    const row = col.addStack();
    row.centerAlignContent();
    if (!compact) {
      const lbl = row.addText(w.label);
      lbl.font = Font.systemFont(10);
      lbl.textColor = SOFT;
      lbl.lineLimit = 1;
      row.addSpacer(4);
    }
    const num = row.addText(w.status === 'open' ? w.serving : w.status);
    num.font = Font.heavyMonospacedSystemFont(compact ? 18 : 20);
    num.textColor = w.status === 'open' ? INK : SOFT;
    num.minimumScaleFactor = 0.5;
  }

  const wait = col.addText(dept.waiting + ' waiting');
  wait.font = Font.mediumSystemFont(10);
  wait.textColor = SOFT;
}

async function build() {
  const w = new ListWidget();
  w.backgroundColor = BG;
  w.setPadding(12, 14, 12, 14);
  w.refreshAfterDate = new Date(Date.now() + 5 * 60 * 1000);
  w.url = SERVER + '/display/cashier';

  const title = w.addText('SmartQ · Now Serving');
  title.font = Font.boldSystemFont(12);
  title.textColor = INK;
  w.addSpacer(6);

  let data;
  try { data = await load(); }
  catch (e) {
    const err = w.addText('Can\'t reach SmartQ.\nCheck SERVER and Wi-Fi.');
    err.font = Font.systemFont(11);
    err.textColor = SOFT;
    return w;
  }

  const small = config.widgetFamily === 'small';
  const body = w.addStack();
  body.layoutHorizontally();
  body.topAlignContent();
  addDept(body, 'Cashier', data.cashier, small);
  body.addSpacer();
  addDept(body, 'Registrar', data.registrar, small);

  w.addSpacer();
  const t = w.addDate(new Date(data.updated));
  t.applyTimeStyle();
  t.font = Font.systemFont(9);
  t.textColor = SOFT;
  return w;
}

const widget = await build();
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentMedium();
Script.complete();

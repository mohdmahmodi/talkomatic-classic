// public/js/staff-ui.js
// Shared staff UI kit used by the lobby, room, and the mod board.

(function () {
  if (window.StaffUI) return;

  // ── styles (injected once; CSP allows inline styles) ──────────────────────
  const CSS = `
  .tk-backdrop *{box-sizing:border-box;}
  .tk-backdrop{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.82);
    display:flex;align-items:center;justify-content:center;
    padding:16px;animation:tkFade .15s ease-out;box-sizing:border-box;}
  @keyframes tkFade{from{opacity:0}to{opacity:1}}
  @keyframes tkRise{from{transform:translateY(12px);opacity:0}to{transform:translateY(0);opacity:1}}
  .tk-card{background:#202020;border:1px solid #616161;
    border-radius:8px;width:100%;max-width:430px;max-height:88vh;display:flex;flex-direction:column;
    box-shadow:0 18px 55px rgba(0,0,0,.6);animation:tkRise .18s ease-out;overflow:hidden;
    box-sizing:border-box;font-family:inherit;color:#fff;}
  .tk-card.tk-wide{max-width:560px;}
  .tk-card.tk-xwide{max-width:960px;max-height:92vh;}
  .tk-head{display:flex;align-items:center;gap:13px;padding:15px 18px;border-bottom:1px solid #616161;
    background:linear-gradient(to bottom,#616161,#303030);}
  .tk-head .tk-ico{font-size:18px;line-height:1;flex:none;width:42px;height:42px;display:flex;
    align-items:center;justify-content:center;border-radius:8px;background:rgba(0,0,0,.3);
    color:#ff9800;border:1px solid rgba(255,152,0,.5);}
  .tk-head .tk-htext{flex:1;min-width:0;}
  .tk-title{font-size:17px;font-weight:bold;color:#ff9800;margin:0;word-break:break-word;}
  .tk-sub{font-size:12.5px;color:#ededed;margin:3px 0 0;line-height:1.45;word-break:break-word;}
  .tk-x{background:none;border:none;color:#fff;font-size:22px;cursor:pointer;line-height:1;
    padding:0 6px;border-radius:4px;flex:none;}
  .tk-x:hover{color:#000;background:#ff9800;}
  .tk-body{padding:16px 18px;overflow-y:auto;overflow-x:hidden;font-size:14px;line-height:1.55;color:#fff;}
  .tk-body p{margin:0 0 10px;word-break:break-word;}
  .tk-foot{display:flex;justify-content:flex-end;gap:8px;padding:14px 18px;border-top:1px solid #616161;flex-wrap:wrap;}
  .tk-btn{appearance:none;border:1px solid transparent;background:#1b1b1b;color:#fff;border-radius:5px;
    padding:10px 16px;font-size:14px;font-weight:bold;cursor:pointer;font-family:inherit;transition:all .15s;max-width:100%;}
  .tk-btn:hover{background:#242424;border-color:#616161;}
  .tk-btn.tk-primary{background:#ff9800;border-color:#ff9800;color:#000;}
  .tk-btn.tk-primary:hover{background:#ffad33;border-color:#ffad33;color:#000;}
  .tk-btn.tk-danger{background:#000;border-color:#616161;color:#ff5468;}
  .tk-btn.tk-danger:hover{background:#ff5468;border-color:#ff5468;color:#1a0005;}
  .tk-btn.tk-ghost{background:transparent;}
  .tk-field{margin:0 0 14px;}
  .tk-field:last-child{margin-bottom:0;}
  .tk-label{display:block;font-size:12px;font-weight:bold;color:#ff9800;margin:0 0 6px;}
  .tk-input,.tk-textarea,.tk-select{width:100%;background:#000;color:#fff;
    border:1px solid #616161;border-radius:5px;padding:10px 12px;font-size:14px;font-family:inherit;
    outline:none;transition:border-color .12s;}
  .tk-textarea{min-height:84px;resize:vertical;line-height:1.5;}
  .tk-input:focus,.tk-textarea:focus,.tk-select:focus{border-color:#ff9800;}
  .tk-help{font-size:11.5px;color:#8d8d8d;margin:6px 0 0;word-break:break-word;}
  .tk-checkbox-row{display:flex;align-items:center;gap:9px;cursor:pointer;
    color:#fff;font-size:13.5px;user-select:none;}
  .tk-checkbox-row input{accent-color:#ff9800;width:16px;height:16px;flex:none;margin:0;}
  .tk-err{font-size:12px;color:#ff5468;margin:6px 0 0;display:none;}
  /* Staff key reveal: masked until asked for, monospace once shown */
  .tk-keybox{display:flex;gap:8px;align-items:center;background:#000;border:1px solid #616161;
    border-radius:5px;padding:10px 12px;margin:10px 0 0;}
  .tk-keyval{flex:1;min-width:0;font-family:"Courier New",monospace;font-size:13px;color:#8d8d8d;
    letter-spacing:2px;word-break:break-all;}
  .tk-keyval.revealed{color:#ff9800;letter-spacing:0;}
  .tk-keyeye{flex:none;padding:6px 12px;font-size:12px;}
  /* menu */
  .tk-group{margin:4px 0 18px;}
  .tk-group:last-child{margin-bottom:0;}
  /* Cream section strip, same as the lobby's "Be Known As..." bar and the
     dashboard's section headers, so every staff surface reads the same. */
  .tk-gtitle{font-size:12.5px;font-weight:bold;letter-spacing:.3px;
    color:#000;background:#fdf5e6;margin:0 0 10px;padding:7px 12px;border-radius:5px;}
  .tk-item{display:flex;align-items:center;gap:12px;width:100%;text-align:left;background:#1b1b1b;
    border:1px solid transparent;border-radius:5px;padding:11px 12px;margin:0 0 6px;cursor:pointer;
    transition:border-color .15s,background .15s;font-family:inherit;color:#fff;}
  .tk-item:last-child{margin-bottom:0;}
  .tk-item:hover{background:#242424;border-color:#ff9800;}
  .tk-item:disabled{opacity:.45;cursor:not-allowed;}
  .tk-item .tk-iico{font-size:15px;width:34px;height:34px;display:flex;align-items:center;justify-content:center;
    border-radius:5px;flex:none;background:rgba(255,152,0,.12);color:#ff9800;}
  .tk-item .tk-itxt{flex:1;min-width:0;}
  .tk-item .tk-ilabel{font-size:14px;font-weight:bold;color:#fff;word-break:break-word;}
  .tk-item .tk-idesc{font-size:12px;color:#9a9a9a;margin-top:2px;line-height:1.4;word-break:break-word;}
  button.tk-item::after{content:"›";color:#616161;font-size:19px;line-height:1;flex:none;font-weight:bold;margin-left:2px;transition:color .15s;}
  button.tk-item:hover::after{color:#ff9800;}
  .tk-item.tk-d .tk-ilabel{color:#ff8a8e;}
  .tk-item.tk-d:hover{border-color:#ff5468;background:#241416;}
  button.tk-item.tk-d:hover::after{color:#ff5468;}
  .tk-iico.t-default{background:rgba(255,152,0,.12);color:#ff9800;}
  .tk-iico.t-danger{background:rgba(255,84,104,.14);color:#ff5468;}
  .tk-iico.t-info{background:rgba(90,169,255,.15);color:#5aa9ff;}
  .tk-iico.t-success{background:rgba(87,217,163,.14);color:#57d9a3;}
  .tk-iico.t-warn{background:rgba(255,180,84,.15);color:#ffb454;}
  .tk-iico.t-broadcast{background:rgba(192,139,255,.16);color:#c08bff;}
  .tk-iico.t-dev{background:rgba(255,84,104,.15);color:#ff5468;}
  .tk-iico.t-mod{background:rgba(90,169,255,.15);color:#5aa9ff;}
  .tk-iico.t-jr{background:rgba(192,139,255,.16);color:#c08bff;}
  /* Rank chips match the room flair and the dashboard: dev red, full mod blue,
     junior mod purple. */
  .tk-chip{display:inline-block;font-size:10px;font-weight:bold;padding:2px 7px;border-radius:4px;
    letter-spacing:.4px;vertical-align:middle;}
  .tk-chip.dev{background:#ff5468;color:#1a0005;}
  .tk-chip.mod{background:#5aa9ff;color:#001229;}
  .tk-chip.jr{background:#c08bff;color:#16002b;}
  /* toasts */
  .tk-toasts,.tk-toast,.tk-toast *{box-sizing:border-box;}
  .tk-toasts{position:fixed;top:14px;right:14px;left:auto;z-index:100002;display:flex;flex-direction:column;
    gap:10px;max-width:340px;}
  .tk-toasts.tk-full{left:14px;right:14px;max-width:none;align-items:center;}
  /* Square: the coloured left edge is what says what kind of message this is,
     and a rounded corner clips it into a sliver. */
  .tk-toast{position:relative;background:#1b1b1b;border:1px solid #333;border-left:4px solid #ff9800;
    border-radius:0;padding:13px 14px 15px;box-shadow:0 10px 30px rgba(0,0,0,.55);
    animation:tkToastIn .18s ease-out;overflow:hidden;
    color:#fff;font-size:14px;line-height:1.5;display:flex;gap:11px;align-items:flex-start;width:100%;}
  @keyframes tkToastIn{from{transform:translateX(14px);opacity:0}to{transform:translateX(0);opacity:1}}
  .tk-toast.tk-tout{opacity:0;transform:translateX(14px);transition:opacity .15s ease,transform .15s ease;}
  .tk-toasts.tk-full .tk-toast{max-width:680px;}
  /* Coloured edge + matching icon so the kind of message reads instantly */
  .tk-toast .tk-tico{flex:none;width:28px;height:28px;border-radius:5px;display:flex;
    align-items:center;justify-content:center;font-size:14px;}
  .tk-toast.info{border-left-color:#5aa9ff;}
  .tk-toast.info .tk-tico{background:rgba(90,169,255,.15);color:#5aa9ff;}
  .tk-toast.info .tk-ttitle{color:#5aa9ff;}
  .tk-toast.success{border-left-color:#57d9a3;}
  .tk-toast.success .tk-tico{background:rgba(87,217,163,.15);color:#57d9a3;}
  .tk-toast.success .tk-ttitle{color:#57d9a3;}
  .tk-toast.warning{border-left-color:#ffb454;}
  .tk-toast.warning .tk-tico{background:rgba(255,180,84,.15);color:#ffb454;}
  .tk-toast.warning .tk-ttitle{color:#ffb454;}
  .tk-toast.error{border-left-color:#ff5468;}
  .tk-toast.error .tk-tico{background:rgba(255,84,104,.15);color:#ff5468;}
  .tk-toast.error .tk-ttitle{color:#ff5468;}
  .tk-toast .tk-ttext{flex:1;min-width:0;word-break:break-word;}
  .tk-toast .tk-ttitle{font-weight:bold;font-size:14px;margin-bottom:2px;}
  .tk-toast .tk-tbody{color:#d6d6d6;font-size:13.5px;}
  .tk-toast .tk-tx{background:none;border:none;color:#8d8d8d;cursor:pointer;font-size:18px;line-height:1;
    padding:0 2px;flex:none;border-radius:4px;}
  .tk-toast .tk-tx:hover{color:#fff;}
  /* Time remaining, so a toast never just vanishes without warning. Hovering
     or focusing the toast pauses it (WCAG 2.2.1, timing adjustable). */
  .tk-toast .tk-tbar{position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(255,255,255,.08);}
  .tk-toast .tk-tfill{height:100%;width:100%;transform-origin:left center;background:currentColor;
    animation-name:tkToastBar;animation-timing-function:linear;animation-fill-mode:forwards;}
  .tk-toast.info .tk-tfill{color:#5aa9ff;}
  .tk-toast.success .tk-tfill{color:#57d9a3;}
  .tk-toast.warning .tk-tfill{color:#ffb454;}
  .tk-toast.error .tk-tfill{color:#ff5468;}
  @keyframes tkToastBar{from{transform:scaleX(1)}to{transform:scaleX(0)}}
  @media (prefers-reduced-motion: reduce){
    .tk-toast{animation:none;}
    .tk-toast .tk-tfill{animation:none;transform:scaleX(1);opacity:.4;}
  }
  /* sliding staff panel: right drawer / bottom sheet / centered window */
  .tk-panel{background:#202020;color:#fff;display:flex;
    flex-direction:column;box-sizing:border-box;font-family:inherit;}
  .tk-panel *{box-sizing:border-box;}
  .tk-pl-drawer{position:fixed;top:0;right:0;height:100vh;height:100dvh;width:380px;max-width:96vw;
    border-left:2px solid #ff9800;z-index:99999;transform:translateX(100%);transition:transform .22s ease;
    box-shadow:-16px 0 42px rgba(0,0,0,.5);}
  .tk-pl-drawer.tk-pl-in{transform:translateX(0);}
  .tk-pl-sheet{width:100%;max-height:88vh;max-height:88dvh;border-top:2px solid #ff9800;
    border-radius:8px 8px 0 0;transform:translateY(100%);transition:transform .24s ease;
    box-shadow:0 -14px 42px rgba(0,0,0,.5);}
  .tk-pl-sheet.tk-pl-in{transform:translateY(0);}
  .tk-pl-center{position:relative;width:100%;max-width:440px;max-height:86vh;border:1px solid #616161;
    border-radius:8px;overflow:hidden;transform:translateY(10px);opacity:0;
    transition:transform .18s ease,opacity .18s ease;box-shadow:0 18px 55px rgba(0,0,0,.6);}
  .tk-pl-center.tk-pl-in{transform:translateY(0);opacity:1;}
  .tk-pl-back{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.66);display:flex;opacity:0;
    transition:opacity .16s ease;box-sizing:border-box;}
  .tk-pl-back.tk-pl-in{opacity:1;}
  .tk-pl-back-center{align-items:center;justify-content:center;padding:16px;}
  .tk-pl-back-sheet{align-items:flex-end;justify-content:center;}
  .tk-phead{position:relative;display:flex;align-items:center;gap:11px;padding:16px 14px;
    border-bottom:1px solid #616161;background:linear-gradient(to bottom,#616161,#303030);}
  .tk-pl-sheet .tk-phead{padding-top:20px;}
  .tk-pl-sheet .tk-phead::before{content:"";position:absolute;top:8px;left:50%;transform:translateX(-50%);
    width:40px;height:4px;border-radius:2px;background:rgba(0,0,0,.4);}
  .tk-pico{width:40px;height:40px;flex:none;display:flex;align-items:center;justify-content:center;
    border-radius:8px;font-size:18px;background:rgba(0,0,0,.3);color:#ff9800;border:1px solid rgba(255,152,0,.5);}
  .tk-phtext{flex:1;min-width:0;}
  .tk-ptitle{font-size:16px;font-weight:bold;color:#ff9800;word-break:break-word;}
  .tk-psub{font-size:12px;color:#ededed;margin-top:1px;word-break:break-word;}
  .tk-pbtn{background:rgba(0,0,0,.25);border:none;color:#fff;cursor:pointer;font-size:15px;line-height:1;width:32px;
    height:32px;border-radius:4px;flex:none;display:flex;align-items:center;justify-content:center;transition:all .12s;}
  .tk-pbtn:hover{color:#000;background:#ff9800;}
  .tk-px{font-size:21px;}
  .tk-pbody{flex:1;overflow-y:auto;overflow-x:hidden;padding:14px;}
  .tk-pl-sheet .tk-pbody{padding-bottom:26px;}
  .tk-presize{position:absolute;left:0;top:0;bottom:0;width:9px;margin-left:-5px;cursor:ew-resize;z-index:2;
    transition:background .12s;}
  .tk-presize:hover{background:linear-gradient(90deg,rgba(255,152,0,.3),transparent);}
  @media (max-width:640px){
    .tk-presize{display:none;}
  }
  @media (max-width:520px){
    .tk-backdrop{padding:10px;align-items:flex-end;}
    .tk-card{max-width:100%;max-height:92vh;border-radius:8px 8px 0 0;}
    .tk-foot{justify-content:stretch;}
    .tk-foot .tk-btn{flex:1;}
    .tk-toasts{top:8px;right:8px;left:8px;max-width:none;}
  }
  `;
  const style = document.createElement("style");
  style.id = "tk-staff-ui-styles";
  style.textContent = CSS;
  (document.head || document.documentElement).appendChild(style);

  function escape(s) {
    return String(s == null ? "" : s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }

  function el(tag, props, children) {
    const e = document.createElement(tag);
    if (props)
      for (const k in props) {
        if (k === "class") e.className = props[k];
        else if (k === "text") e.textContent = props[k];
        else if (k === "html")
          e.innerHTML = props[k];
        else if (k.startsWith("on") && typeof props[k] === "function")
          e.addEventListener(k.slice(2).toLowerCase(), props[k]);
        else if (props[k] != null) e.setAttribute(k, props[k]);
      }
    if (children)
      (Array.isArray(children) ? children : [children]).forEach((c) => {
        if (c == null) return;
        e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      });
    return e;
  }

  function iconNode(val, cls) {
    const s = String(val == null ? "" : val);
    return /^\s*<i\b/.test(s)
      ? el("div", { class: cls, html: s })
      : el("div", { class: cls, text: s });
  }

  const TONE_BY_ICON = {
    ban: "danger",
    bomb: "danger",
    trash: "danger",
    "user-slash": "danger",
    gavel: "danger",
    bullhorn: "warn",
    lock: "warn",
    "fire-extinguisher": "warn",
    "triangle-exclamation": "warn",
    "user-secret": "warn",
    "screwdriver-wrench": "warn",
    gauge: "info",
    "chart-simple": "info",
    flag: "info",
    globe: "info",
    list: "info",
    clipboard: "info",
    snowflake: "info",
    unlock: "info",
    "magnifying-glass": "info",
    "circle-info": "info",
    "user-plus": "success",
    "user-shield": "success",
    "lock-open": "success",
    "circle-check": "success",
    "tower-broadcast": "broadcast",
    newspaper: "broadcast",
    "champagne-glasses": "broadcast",
    star: "broadcast",
    ghost: "dev",
    crown: "dev",
  };
  const TONE_SKIP = new Set([
    "solid",
    "regular",
    "brands",
    "light",
    "thin",
    "duotone",
    "sharp",
    "fw",
    "lg",
    "sm",
    "xs",
    "spin",
    "pulse",
    "beat",
    "fade",
  ]);
  function iconTone(icon) {
    const re = /fa-([a-z0-9-]+)/gi;
    let m;
    while ((m = re.exec(String(icon == null ? "" : icon)))) {
      if (!TONE_SKIP.has(m[1])) return TONE_BY_ICON[m[1]] || "default";
    }
    return "default";
  }

  let openCount = 0;

  function modal(opts) {
    const o = opts || {};
    const backdrop = el("div", { class: "tk-backdrop" });
    const card = el("div", {
      class:
        "tk-card" + (o.xwide ? " tk-xwide" : o.wide ? " tk-wide" : ""),
    });

    const head = el("div", { class: "tk-head" });
    if (o.icon) head.appendChild(iconNode(o.icon, "tk-ico"));
    const htext = el("div", { class: "tk-htext" });
    htext.appendChild(el("div", { class: "tk-title", text: o.title || "" }));
    if (o.subtitle)
      htext.appendChild(el("div", { class: "tk-sub", text: o.subtitle }));
    head.appendChild(htext);
    const xBtn = el("button", { class: "tk-x", text: "×", title: "Close" });
    head.appendChild(xBtn);
    card.appendChild(head);

    const body = el("div", { class: "tk-body" });
    if (typeof o.body === "string") body.appendChild(el("p", { text: o.body }));
    else if (o.body) body.appendChild(o.body);
    card.appendChild(body);

    let foot = null;
    if (o.actions && o.actions.length) {
      foot = el("div", { class: "tk-foot" });
      o.actions.forEach((a) => {
        const b = el("button", {
          class:
            "tk-btn" +
            (a.kind === "primary"
              ? " tk-primary"
              : a.kind === "danger"
                ? " tk-danger"
                : a.kind === "ghost"
                  ? " tk-ghost"
                  : ""),
          text: a.label,
        });
        b.addEventListener("click", () => {
          if (a.onClick && a.onClick() === false) return;
          close();
        });
        foot.appendChild(b);
      });
      card.appendChild(foot);
    }

    function close() {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      openCount = Math.max(0, openCount - 1);
      if (o.onClose) o.onClose();
    }
    function onKey(e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    }
    xBtn.addEventListener("click", close);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop && o.dismissable !== false) close();
    });
    document.addEventListener("keydown", onKey);
    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    openCount++;
    return { close, card, body };
  }

  function alert(title, message, icon) {
    return new Promise((res) => {
      modal({
        title,
        icon: icon || '<i class="fas fa-circle-info"></i>',
        body: message,
        dismissable: true,
        onClose: res,
        actions: [{ label: "OK", kind: "primary", onClick: () => {} }],
      });
    });
  }

  function confirm(opts) {
    const o = typeof opts === "string" ? { message: opts } : opts || {};
    return new Promise((res) => {
      let answered = false;
      modal({
        title: o.title || "Are you sure?",
        icon:
          o.icon ||
          (o.danger
            ? '<i class="fas fa-triangle-exclamation"></i>'
            : '<i class="fas fa-circle-question"></i>'),
        subtitle: o.subtitle,
        body: o.message,
        onClose: () => {
          if (!answered) res(false);
        },
        actions: [
          {
            label: o.cancelText || "Cancel",
            kind: "ghost",
            onClick: () => {
              answered = true;
              res(false);
            },
          },
          {
            label: o.confirmText || "Confirm",
            kind: o.danger ? "danger" : "primary",
            onClick: () => {
              answered = true;
              res(true);
            },
          },
        ],
      });
    });
  }

  function prompt(opts) {
    const o = opts || {};
    const fields = o.fields || [
      { name: "value", label: o.label || "Value", placeholder: o.placeholder },
    ];
    return new Promise((res) => {
      const form = el("form", { class: "tk-form" });
      if (o.message) form.appendChild(el("p", { text: o.message }));
      const inputs = {};
      fields.forEach((f) => {
        const wrap = el("div", { class: "tk-field" });
        if (f.type === "checkbox") {
          const cb = el("input", { type: "checkbox", class: "tk-checkbox" });
          cb.checked = !!f.value;
          const row = el("label", { class: "tk-checkbox-row" });
          row.appendChild(cb);
          if (f.label) row.appendChild(el("span", { text: f.label }));
          wrap.appendChild(row);
          inputs[f.name] = cb;
          if (f.help)
            wrap.appendChild(el("div", { class: "tk-help", text: f.help }));
          form.appendChild(wrap);
          return;
        }
        if (f.label)
          wrap.appendChild(el("label", { class: "tk-label", text: f.label }));
        let input;
        if (f.type === "textarea") {
          input = el("textarea", {
            class: "tk-textarea",
            placeholder: f.placeholder || "",
            maxlength: f.maxLength,
            rows: f.rows,
          });
          if (f.value) input.value = f.value;
        } else if (f.type === "select") {
          input = el("select", { class: "tk-select" });
          (f.options || []).forEach((opt) => {
            const ov = typeof opt === "string" ? opt : opt.value;
            const ol = typeof opt === "string" ? opt : opt.label;
            const o2 = el("option", { value: ov, text: ol });
            if (f.value === ov) o2.selected = true;
            input.appendChild(o2);
          });
        } else {
          input = el("input", {
            class: "tk-input",
            type: f.type || "text",
            placeholder: f.placeholder || "",
            maxlength: f.maxLength,
          });
          if (f.value != null) input.value = f.value;
        }
        inputs[f.name] = input;
        wrap.appendChild(input);
        if (f.help)
          wrap.appendChild(el("div", { class: "tk-help", text: f.help }));
        form.appendChild(wrap);
      });
      const errEl = el("div", { class: "tk-err" });
      form.appendChild(errEl);

      let answered = false;
      const submit = () => {
        const values = {};
        for (const f of fields) {
          if (f.type === "checkbox") {
            values[f.name] = inputs[f.name].checked;
            continue;
          }
          const v = inputs[f.name].value;
          if (f.required && !String(v).trim()) {
            errEl.textContent = `${f.label || f.name} is required.`;
            errEl.style.display = "block";
            inputs[f.name].focus();
            return false;
          }
          values[f.name] = v;
        }
        answered = true;
        res(
          fields.length === 1 && fields[0].name === "value"
            ? values.value
            : values,
        );
        return true;
      };

      form.addEventListener("submit", (e) => {
        e.preventDefault();
        if (submit()) ctrl.close();
      });

      const ctrl = modal({
        title: o.title || "Input",
        icon: o.icon || '<i class="fas fa-pen"></i>',
        subtitle: o.subtitle,
        wide: o.wide,
        body: form,
        onClose: () => {
          if (!answered) res(null);
        },
        actions: [
          { label: o.cancelText || "Cancel", kind: "ghost", onClick: () => {} },
          {
            label: o.confirmText || "Submit",
            kind: o.danger ? "danger" : "primary",
            onClick: () => submit(),
          },
        ],
      });
      setTimeout(() => {
        const first = inputs[fields[0].name];
        if (first) first.focus();
      }, 50);
    });
  }

  function renderGroups(groups, getClose, closeOnClick) {
    const wrap = el("div");
    (groups || []).forEach((g) => {
      const gEl = el("div", { class: "tk-group" });
      if (g.title)
        gEl.appendChild(el("div", { class: "tk-gtitle", text: g.title }));
      (g.items || []).forEach((it) => {
        const btn = el("button", {
          class: "tk-item" + (it.danger ? " tk-d" : ""),
          type: "button",
        });
        if (it.id) btn.id = it.id;
        if (it.disabled) btn.disabled = true;
        const tone = it.tone || (it.danger ? "danger" : iconTone(it.icon));
        btn.appendChild(iconNode(it.icon || "•", "tk-iico t-" + tone));
        const tx = el("div", { class: "tk-itxt" });
        tx.appendChild(el("div", { class: "tk-ilabel", text: it.label }));
        if (it.desc)
          tx.appendChild(el("div", { class: "tk-idesc", text: it.desc }));
        btn.appendChild(tx);
        btn.addEventListener("click", () => {
          if (closeOnClick && !it.keepOpen) {
            const c = getClose && getClose();
            if (c) c();
          }
          if (it.onClick) it.onClick();
        });
        gEl.appendChild(btn);
      });
      wrap.appendChild(gEl);
    });
    return wrap;
  }

  function menu(opts) {
    const o = opts || {};
    let ctrl;
    const wrap = renderGroups(o.groups, () => ctrl && ctrl.close, true);
    const actions = [];
    if (o.onHelp)
      actions.push({
        label: "Help",
        kind: "ghost",
        onClick: () => {
          o.onHelp();
          return false;
        },
      });
    actions.push({ label: "Close", kind: "ghost", onClick: () => {} });
    ctrl = modal({
      title: o.title || "Menu",
      icon: o.icon || '<i class="fas fa-screwdriver-wrench"></i>',
      subtitle: o.subtitle,
      wide: o.wide,
      body: wrap,
      actions,
    });
    return ctrl;
  }

  const PANEL_MODE_KEY = "talkomatic_staffMenuMode";
  const PANEL_WIDTH_KEY = "talkomatic_staffDrawerW";
  let activePanel = null;
  function isNarrow() {
    return window.matchMedia("(max-width:640px)").matches;
  }
  function panelMode() {
    try {
      const m = localStorage.getItem(PANEL_MODE_KEY);
      if (m === "modal" || m === "drawer") return m;
    } catch (_) {}
    return "drawer";
  }
  function setPanelMode(m) {
    try {
      localStorage.setItem(PANEL_MODE_KEY, m);
    } catch (_) {}
  }
  function drawerWidth() {
    let w = 380;
    try {
      w = parseInt(localStorage.getItem(PANEL_WIDTH_KEY), 10) || 380;
    } catch (_) {}
    return Math.max(300, Math.min(560, w));
  }
  function saveDrawerWidth(w) {
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(w)));
    } catch (_) {}
  }

  function panel(opts) {
    if (activePanel) {
      activePanel.close();
      return null;
    }
    const o = opts || {};
    const mode = isNarrow()
      ? "sheet"
      : panelMode() === "modal"
        ? "center"
        : "drawer";
    let closed = false;
    let root = null;
    const panelEl = el("div", { class: "tk-panel tk-pl-" + mode });

    function fireLayout() {
      if (o.onLayoutChange) {
        try {
          o.onLayoutChange();
        } catch (_) {}
      }
    }
    function close() {
      if (closed) return;
      closed = true;
      activePanel = null;
      document.removeEventListener("keydown", onKey);
      panelEl.classList.remove("tk-pl-in");
      if (root) root.classList.remove("tk-pl-in");
      if (mode === "drawer") {
        document.documentElement.classList.remove("tk-drawer-open");
        fireLayout();
        setTimeout(fireLayout, 240);
      }
      setTimeout(() => {
        const node = root || panelEl;
        if (node && node.parentNode) node.parentNode.removeChild(node);
      }, 230);
      if (o.onClose) o.onClose();
    }
    function onKey(e) {
      if (e.key === "Escape") {
        if (openCount > 0) return;
        e.stopPropagation();
        close();
      }
    }

    const head = el("div", { class: "tk-phead" });
    if (o.icon) head.appendChild(iconNode(o.icon, "tk-pico"));
    const htext = el("div", { class: "tk-phtext" });
    htext.appendChild(
      el("div", { class: "tk-ptitle", text: o.title || "Staff tools" }),
    );
    if (o.subtitle)
      htext.appendChild(el("div", { class: "tk-psub", text: o.subtitle }));
    head.appendChild(htext);
    if (!isNarrow()) {
      const tg = el("button", {
        class: "tk-pbtn",
        type: "button",
        title:
          mode === "drawer"
            ? "Switch to a centered window"
            : "Dock to the right",
      });
      tg.innerHTML =
        mode === "drawer"
          ? '<i class="fas fa-window-maximize"></i>'
          : '<i class="fas fa-table-columns"></i>';
      tg.addEventListener("click", () => {
        setPanelMode(mode === "drawer" ? "modal" : "drawer");
        close();
        setTimeout(() => panel(o), 250);
      });
      head.appendChild(tg);
    }
    if (o.onHelp) {
      const hb = el("button", {
        class: "tk-pbtn",
        type: "button",
        title: "Help",
      });
      hb.innerHTML = '<i class="fas fa-circle-question"></i>';
      hb.addEventListener("click", () => o.onHelp());
      head.appendChild(hb);
    }
    const xb = el("button", {
      class: "tk-pbtn tk-px",
      type: "button",
      text: "×",
      title: "Close",
    });
    xb.addEventListener("click", close);
    head.appendChild(xb);
    panelEl.appendChild(head);

    const body = el("div", { class: "tk-pbody" });
    body.appendChild(renderGroups(o.groups, () => close, false));
    panelEl.appendChild(body);

    if (mode === "drawer") {
      const rh = el("div", { class: "tk-presize", title: "Drag to resize" });
      let dragging = false,
        startX = 0,
        startW = 0;
      rh.addEventListener("pointerdown", (e) => {
        dragging = true;
        startX = e.clientX;
        startW = panelEl.offsetWidth;
        try {
          rh.setPointerCapture(e.pointerId);
        } catch (_) {}
        e.preventDefault();
      });
      rh.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        let w = startW + (startX - e.clientX);
        w = Math.max(300, Math.min(560, w));
        panelEl.style.width = w + "px";
        document.documentElement.style.setProperty("--tk-drawer-w", w + "px");
        fireLayout();
      });
      const end = (e) => {
        if (!dragging) return;
        dragging = false;
        try {
          rh.releasePointerCapture(e.pointerId);
        } catch (_) {}
        saveDrawerWidth(panelEl.offsetWidth);
        fireLayout();
        setTimeout(fireLayout, 60);
      };
      rh.addEventListener("pointerup", end);
      rh.addEventListener("pointercancel", end);
      panelEl.appendChild(rh);
    }

    activePanel = { close };

    if (mode === "drawer") {
      const w = drawerWidth();
      panelEl.style.width = w + "px";
      document.documentElement.style.setProperty("--tk-drawer-w", w + "px");
      document.body.appendChild(panelEl);
      document.documentElement.classList.add("tk-drawer-open");
      requestAnimationFrame(() => panelEl.classList.add("tk-pl-in"));
      fireLayout();
      setTimeout(fireLayout, 240);
    } else {
      root = el("div", { class: "tk-pl-back tk-pl-back-" + mode });
      root.appendChild(panelEl);
      root.addEventListener("click", (e) => {
        if (e.target === root && o.dismissable !== false) close();
      });
      document.body.appendChild(root);
      requestAnimationFrame(() => {
        root.classList.add("tk-pl-in");
        panelEl.classList.add("tk-pl-in");
      });
    }
    document.addEventListener("keydown", onKey);
    return { close };
  }

  let toastHost = null;
  function ensureHost(full) {
    if (!toastHost) {
      toastHost = el("div", { class: "tk-toasts" });
      document.body.appendChild(toastHost);
    }
    toastHost.className = "tk-toasts" + (full ? " tk-full" : "");
    return toastHost;
  }
  const TOAST_ICON = {
    success: "fa-circle-check",
    error: "fa-circle-exclamation",
    warning: "fa-triangle-exclamation",
    info: "fa-circle-info",
  };

  function toastDuration(type, text, title) {
    if (type === "error") return 0;
    const words = String((title || "") + " " + (text || "")).trim().split(/\s+/)
      .length;
    return Math.min(14000, Math.max(5000, 2200 + words * 380));
  }

  function toast(message, opts) {
    const o = opts || {};
    const host = ensureHost(o.fullWidth);
    const type = o.type || "info";
    const body = String(message == null ? "" : message);
    const t = el("div", { class: "tk-toast " + type });
    t.setAttribute("role", type === "error" ? "alert" : "status");
    t.setAttribute("aria-live", type === "error" ? "assertive" : "polite");
    t.setAttribute("aria-atomic", "true");

    t.appendChild(
      iconNode(
        '<i class="fas ' + (TOAST_ICON[type] || TOAST_ICON.info) + '"></i>',
        "tk-tico",
      ),
    );

    const txt = el("div", { class: "tk-ttext" });
    if (o.title)
      txt.appendChild(el("div", { class: "tk-ttitle", text: o.title }));
    if (body) txt.appendChild(el("div", { class: "tk-tbody", text: body }));
    t.appendChild(txt);

    const x = el("button", { class: "tk-tx", text: "×" });
    x.setAttribute("aria-label", "Dismiss");
    const close = () => {
      t.classList.add("tk-tout");
      setTimeout(() => t.remove(), 160);
    };
    x.addEventListener("click", close);
    t.appendChild(x);

    const ms = o.timeout != null ? o.timeout : toastDuration(type, body, o.title);
    if (ms > 0) {
      const bar = el("div", { class: "tk-tbar" });
      const fill = el("div", { class: "tk-tfill" });
      fill.style.animationDuration = ms + "ms";
      bar.appendChild(fill);
      t.appendChild(bar);

      let timer = null;
      let startedAt = 0;
      let left = ms;
      const start = () => {
        startedAt = Date.now();
        fill.style.animationPlayState = "running";
        timer = setTimeout(close, left);
      };
      const hold = () => {
        if (!timer) return;
        clearTimeout(timer);
        timer = null;
        left = Math.max(600, left - (Date.now() - startedAt));
        fill.style.animationPlayState = "paused";
      };
      t.addEventListener("mouseenter", hold);
      t.addEventListener("focusin", hold);
      t.addEventListener("mouseleave", start);
      t.addEventListener("focusout", start);
      host.appendChild(t);
      start();
      return t;
    }

    host.appendChild(t);
    return t;
  }

  function actionToast(d) {
    if (!d) return;
    const who = d.username || d.name || null;
    const target = who ? '"' + who + '"' : "that user";
    const A = d.action || "action";

    if (!d.ok) {
      toast(d.error || "The server refused it. You may not have the level for this action, or the user has already gone.", {
        type: "error",
        title: "Could not " + A,
      });
      return;
    }

    let title = null;
    let body = null;
    switch (A) {
      case "kick":
        title = d.ban ? "Kicked and room-banned" : "Kicked";
        body = d.ban
          ? target + " was removed and cannot rejoin this room."
          : target + " was removed from the room. They can rejoin.";
        break;
      case "ip block":
        title = "Blocked";
        body =
          (who ? target : "That user") +
          " was disconnected and cannot reconnect for " +
          (d.duration === "permanent" ? "good" : d.duration || "a while") +
          (d.rangeApplied
            ? ". Their whole network range is covered, so a neighbouring address will not get them back in."
            : ". This covers one address only.");
        break;
      case "ban ip":
        title = d.placed > 1 ? d.placed + " blocks placed" : "Block placed";
        body =
          "They take effect now, for " +
          (d.duration === "permanent" ? "good" : d.duration || "a while") +
          (d.rangeApplied ? ", covering whole ranges." : ".") +
          (d.skipped
            ? " " +
              d.skipped +
              (d.skipped === 1 ? " entry was" : " entries were") +
              " skipped: not an address, a range, or a client id."
            : "");
        break;
      case "unblock ip":
        title = d.removed ? "Unbanned" : "Nothing to unban";
        body = d.removed
          ? "They can connect again straight away."
          : "That block had already expired or been lifted.";
        break;
      case "set block duration":
        title = "Ban re-timed";
        body = "The countdown restarts from now.";
        break;
      case "set block message":
        title = "Ban message saved";
        body = "They will see it on the ban screen next time they try to connect.";
        break;
      case "warn":
        title = "Warning sent";
        body = target + " has been told. It is recorded in the audit log.";
        break;
      case "rename":
        title = "Name reset";
        body = "They are now shown as Anonymous.";
        break;
      case "reset location":
        title = "Location reset";
        body = 'Their location is back to "On The Web".';
        break;
      case "turn pfp off":
        title = "Profile picture removed";
        body = "They cannot put it back until staff allow it again.";
        break;
      case "allow pfp":
        title = "Profile picture allowed";
        body = "They can set one again.";
        break;
      case "rename room":
        title = "Room renamed";
        body = d.name ? 'It is now "' + d.name + '".' : "Everyone in it was told.";
        break;
      case "lock room":
        title = d.locked ? "Room locked" : "Room unlocked";
        body = d.locked
          ? "Nobody new can join. People already inside stay."
          : "Anyone can join again.";
        break;
      case "slow mode":
        title = d.enabled ? "Slow mode on" : "Slow mode off";
        body = d.enabled
          ? "The room updates more slowly for everyone."
          : "The room updates at normal speed again.";
        break;
      case "close room":
        title = "Room closed";
        body = "Everyone was removed and the room is gone.";
        break;
      case "wipe buffer":
        title = "Text wiped";
        body = "What they had typed is gone from every screen.";
        break;
      case "set note":
        title = "Note saved";
        body = "Other staff will see it on their row.";
        break;
      case "clear note":
        title = "Note cleared";
        break;
      case "revoke mod":
        title = "Mod key revoked";
        body = "Their access was removed immediately.";
        break;
      case "review application":
        title = "Application reviewed";
        body = "The applicant has been told the outcome.";
        break;
      default:
        title = A.charAt(0).toUpperCase() + A.slice(1);
        body = "Done.";
    }
    toast(body, { type: "success", title });
  }

  function copy(text) {
    try {
      if (navigator.clipboard) return navigator.clipboard.writeText(text);
    } catch (_) {}
    return Promise.resolve();
  }

  // ── Help: what every tool does and how to use it ─────────────────────────
  // ── Help: what every tool does, and the lowest rank that may use it ──────
  const HELP = [
    {
      title: "Per-user actions (tap a user's row in a room)",
      items: [
        [
          "Wipe typed text",
          "jr",
          "Clears what the user has typed from everyone's screen. The fastest way to pull a slur off the page.",
        ],
        [
          "Reset name to Anonymous",
          "jr",
          "Resets an offensive username.",
        ],
        [
          "Reset location",
          "jr",
          "Puts an offensive location line back to \"On The Web\".",
        ],
        [
          "Turn profile picture off",
          "jr",
          "Removes their picture and stops them re-adding it until staff allow it again.",
        ],
        [
          "Warn",
          "jr",
          "Sends a private warning to one user, a heads up before you kick.",
        ],
        [
          "Kick from room",
          "jr",
          "Removes the user from the room. They can come back, so pair it with a warning.",
        ],
        [
          "Kick + room ban",
          "jr",
          "Removes the user and bans them from that room so they can't rejoin.",
        ],
        [
          "IP block",
          "mod",
          "Blocks the user's address and disconnects them. Full mods pick 1h / 24h / 7d; devs can also pick permanent.",
        ],
        [
          "Freeze / unfreeze",
          "dev",
          "Locks the user's input server-side so they can't type, without kicking them.",
        ],
      ],
    },
    {
      title: "Room controls (Staff button in the room top bar)",
      items: [
        [
          "Clear Talkoboard",
          "jr",
          "Wipes the shared drawing board for the room.",
        ],
        [
          "Rename room",
          "jr",
          "Fixes a bad or misleading room name. Everyone in the room is told, and it is logged.",
        ],
        [
          "Lock room",
          "jr",
          "Blocks new joins; people already inside stay. Good for calming a raid.",
        ],
        [
          "Slow mode",
          "jr",
          "Throttles how fast the room updates for everyone.",
        ],
        [
          "Close room",
          "mod",
          "Kicks everyone and deletes the room (for slur names / spam farms).",
        ],
        [
          "Megaphone (this room)",
          "dev",
          "Shows an announcement banner to everyone in the room.",
        ],
        ["Party mode", "dev", "Confetti + party horn for the whole room."],
        [
          "Spotlight",
          "dev",
          "Pins the room to the top of the lobby with an Official badge.",
        ],
        [
          "Server HUD",
          "dev",
          "Live overlay of sockets / rooms / heap / solo-TTL.",
        ],
      ],
    },
    {
      title: "Boards (Mod Dashboard)",
      items: [
        [
          "Reports, appeals, applications",
          "mod",
          "The review queues. Full mods and devs triage what the community reports and who applies to help.",
        ],
        [
          "Ban list",
          "mod",
          "Every active block, grouped per person, with one-tap unban.",
        ],
      ],
    },
    {
      title: "Lobby / global (Dev Panel button in the lobby)",
      items: [
        [
          "Grant mod key",
          "dev",
          "Mints a key at either level. Devs only.",
        ],
        [
          "Manage / revoke mod keys",
          "dev",
          "Lists current mod keys; revoke instantly downgrades that mod live.",
        ],
        [
          "Lobby ticker",
          "dev",
          "Editable banner at the top of the lobby, changeable live.",
        ],
        [
          "Megaphone (everywhere)",
          "dev",
          "Broadcasts an announcement to every room and the lobby.",
        ],
        [
          "Feature flags",
          "dev",
          "Toggle the word filter, room creation, and room limit at runtime.",
        ],
        [
          "Maintenance mode",
          "dev",
          "Blocks new rooms and joins with a friendly message for safe deploys.",
        ],
        [
          "Spectate",
          "mod",
          "Watch any room read-only without taking a slot or appearing.",
        ],
        [
          "Clear blacklist / unblock IP",
          "dev",
          "Lifts bot-blacklist entries or a specific block.",
        ],
        ["Nuke", "dev", "Emergency clear of ALL rooms. Requires confirmation."],
      ],
    },
    {
      title: "Accountability",
      items: [
        [
          "Mod Dashboard",
          "jr",
          "Every staff action and every username / name change, live. Keeps everyone honest, including you.",
        ],
      ],
    },
  ];

  function help(role) {
    const RANKS = {
      jr: { n: 1, chip: "jr", label: "All staff", icon: "fa-shield-halved" },
      mod: { n: 2, chip: "mod", label: "Full mod", icon: "fa-shield-halved" },
      dev: { n: 3, chip: "dev", label: "Dev only", icon: "fa-crown" },
    };
    const mine = RANKS[role] ? RANKS[role].n : 1;
    const wrap = el("div");
    wrap.appendChild(
      el("p", {
        text:
          mine >= 3
            ? "You are a developer, so everything below is available to you."
            : mine === 2
              ? "You are a full mod (L2). Items marked Dev only are restricted to developers."
              : "You are a junior mod (L1). Items marked Full mod or Dev only are not available to you yet; they are listed so you can see what the next level adds.",
      }),
    );
    HELP.forEach((sec) => {
      const g = el("div", { class: "tk-group" });
      g.appendChild(el("div", { class: "tk-gtitle", text: sec.title }));
      sec.items.forEach(([name, who, desc]) => {
        const r = RANKS[who] || RANKS.jr;
        const locked = r.n > mine;
        const row = el("div", {
          class: "tk-item",
          style: "cursor:default" + (locked ? ";opacity:.5" : ""),
        });
        row.appendChild(
          iconNode(
            '<i class="fas ' + r.icon + '"></i>',
            "tk-iico t-" + r.chip,
          ),
        );
        const tx = el("div", { class: "tk-itxt" });
        const labelRow = el("div", { class: "tk-ilabel" });
        labelRow.appendChild(document.createTextNode(name + "  "));
        labelRow.appendChild(
          el("span", { class: "tk-chip " + r.chip, text: r.label }),
        );
        tx.appendChild(labelRow);
        tx.appendChild(el("div", { class: "tk-idesc", text: desc }));
        row.appendChild(tx);
        g.appendChild(row);
      });
      wrap.appendChild(g);
    });
    return modal({
      title: "Staff help",
      icon: '<i class="fas fa-book-open"></i>',
      subtitle: "What each tool does and how to use it",
      wide: true,
      body: wrap,
      actions: [{ label: "Got it", kind: "primary", onClick: () => {} }],
    });
  }

  // ── Community-rule picker for report and block prompts ────────────────────
  let communityRules = null;

  function fetchCommunityRules() {
    return new Promise((resolve) => {
      if (communityRules) return resolve(communityRules);
      const s = window.socket;
      if (!s || !s.connected) return resolve(null);
      const timer = setTimeout(done, 1500);
      function done(d) {
        clearTimeout(timer);
        s.off("rules data", done);
        if (d && Array.isArray(d.community) && d.community.length)
          communityRules = d.community;
        resolve(communityRules);
      }
      s.on("rules data", done);
      s.emit("rules get");
    });
  }

  async function communityRuleField() {
    const list = await fetchCommunityRules();
    if (!list || !list.length) return null;
    const options = [{ value: "", label: "No specific rule" }];
    list.forEach((r, i) => {
      if (!r || !r.title) return;
      options.push({
        value: "Rule " + (i + 1) + " - " + r.title,
        label: i + 1 + ". " + r.title,
      });
    });
    return {
      name: "rule",
      label: "Broke a rule? (optional)",
      type: "select",
      value: "",
      options,
    };
  }

  function ruleReason(rule, text) {
    const t = String(text || "").trim();
    if (!rule) return t;
    return t ? rule + ". " + t : rule + ".";
  }

  window.StaffUI = {
    escape,
    el,
    modal,
    alert,
    confirm,
    prompt,
    menu,
    panel,
    toast,
    actionToast,
    copy,
    help,
    communityRuleField,
    ruleReason,
  };
})();

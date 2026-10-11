/* MH Cloud - Phase 1 UI logic */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var S = {
    authMode: 'pass',
    pem: '',
    pemName: '',
    conn: null,        // {host, port, username, password, privateKey, passphrase, fingerprint}
    status: null,
    term: null,
    fit: null,
    shellId: null,
    ctrl: false,
    busy: false,
    view: 'home'
  };

  // ------------------------------------------------------------ small helpers

  function show(id) {
    var list = document.querySelectorAll('.screen');
    for (var i = 0; i < list.length; i++) list[i].classList.remove('active');
    $(id).classList.add('active');
  }

  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, ms || 2600);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function errCode(e) { return (e && e.code) || 'error'; }
  function errMsg(e) { return (e && (e.message || e.errorMessage)) || String(e || 'Unknown error'); }

  // ------------------------------------------------------------ connect screen

  function setAuthMode(mode) {
    S.authMode = mode;
    $('tabPass').classList.toggle('on', mode === 'pass');
    $('tabKey').classList.toggle('on', mode === 'key');
    $('panePass').classList.toggle('hidden', mode !== 'pass');
    $('paneKey').classList.toggle('hidden', mode !== 'key');
  }

  function showSteps(labels, active) {
    var box = $('connSteps');
    box.classList.remove('hidden');
    box.innerHTML = labels.map(function (l, i) {
      var cls = i < active ? 'done' : (i === active ? 'on' : '');
      var mark = i < active ? '&#10003; ' : (i === active ? '&#9679; ' : '&#9675; ');
      return '<div class="' + cls + '">' + mark + esc(l) + '</div>';
    }).join('');
  }
  var STEP_LABELS = ['Reaching the server', 'Verifying the server', 'Logging in', 'Checking your VPS'];

  function hideSteps() { $('connSteps').classList.add('hidden'); }

  function setBusy(b) {
    S.busy = b;
    $('connectBtn').disabled = b;
    $('connectBtn').textContent = b ? 'Connecting...' : 'Connect';
  }

  function friendlyError(e) {
    switch (errCode(e)) {
      case 'bad_input': return errMsg(e);
      case 'auth_failed':
        return 'Login failed. Check the username and the password / PEM key. ' +
          'Common usernames: ubuntu (Ubuntu), admin (Debian), ec2-user (Amazon Linux), root.';
      case 'key_error':
        return 'The key could not be read. Make sure you chose the right .pem file (and typed its passphrase if it has one). ' +
          'RSA .pem keys (AWS / Lightsail default) work best.';
      case 'unknown_host': return 'That address could not be found. Check the IP address.';
      case 'refused': return 'Connection refused. Check that SSH is running on the server and the port is correct.';
      case 'timeout':
      case 'unreachable':
        return 'The server did not respond. Check the IP, your internet, and that port 22 is open in the VPS firewall (Lightsail: Networking tab).';
      case 'host_changed':
        return 'Warning: this server\'s fingerprint is different from the one you trusted before. ' +
          'This can happen after re-installing the server, but it can also mean someone is intercepting the connection.';
      case 'not_native': return errMsg(e);
      default: return errMsg(e);
    }
  }

  function showConnError(e, params) {
    var box = $('connError');
    var html = esc(friendlyError(e));
    if (errCode(e) === 'host_changed') {
      html += '<button id="retrustBtn" class="btn ghost">I changed the server - trust the new fingerprint</button>';
    }
    box.innerHTML = html;
    box.classList.remove('hidden');
    hideSteps();
    var rb = $('retrustBtn');
    if (rb) {
      rb.onclick = function () {
        var p = {}; for (var k in params) p[k] = params[k];
        p.trustedFingerprint = '';
        connectFlow(p, { remember: $('remember').checked });
      };
    }
  }

  function askTrust(fp, type) {
    return new Promise(function (resolve) {
      $('fpText').textContent = fp;
      $('fpType').textContent = type ? 'Key type: ' + type : '';
      $('modal').classList.remove('hidden');
      $('fpYes').onclick = function () { $('modal').classList.add('hidden'); resolve(true); };
      $('fpNo').onclick = function () { $('modal').classList.add('hidden'); resolve(false); };
    });
  }

  function readForm() {
    var port = parseInt($('port').value, 10);
    return {
      host: $('host').value.trim(),
      port: (port > 0 && port < 65536) ? port : 22,
      username: $('user').value.trim() || 'root',
      password: S.authMode === 'pass' ? $('pass').value : '',
      privateKey: S.authMode === 'key' ? S.pem : '',
      passphrase: S.authMode === 'key' ? $('passphrase').value : '',
      trustedFingerprint: ''
    };
  }

  function validateForm(p) {
    if (!p.host) return 'Enter the VPS IP address';
    if (S.authMode === 'pass' && !p.password) return 'Enter the password';
    if (S.authMode === 'key' && !p.privateKey) return 'Choose your .pem key file';
    if (S.authMode === 'key' && p.privateKey.indexOf('PRIVATE KEY') < 0) return 'This file does not look like a private key (.pem)';
    return '';
  }

  function saveVault(p, fingerprint) {
    var data = JSON.stringify({
      host: p.host, port: p.port, username: p.username,
      authMode: p.privateKey ? 'key' : 'pass',
      password: p.password, privateKey: p.privateKey, passphrase: p.passphrase,
      pemName: S.pemName, fingerprint: fingerprint
    });
    return Ssh.vaultSave({ data: data });
  }

  function connectFlow(p, opts) {
    opts = opts || {};
    $('connError').classList.add('hidden');
    setBusy(true);
    showSteps(STEP_LABELS, 0);
    var res;
    return Ssh.connect(p).then(function (r) {
      res = r;
      if (res.status === 'untrusted') {
        showSteps(STEP_LABELS, 1);
        if (!$('screen-connect').classList.contains('active')) show('screen-connect');
        return askTrust(res.fingerprint, res.keyType).then(function (ok) {
          if (!ok) throw { code: 'bad_input', message: 'Cancelled. The server was not trusted.' };
          var p2 = {}; for (var k in p) p2[k] = p[k];
          p2.trustedFingerprint = res.fingerprint;
          p = p2;
          showSteps(STEP_LABELS, 2);
          return Ssh.connect(p);
        });
      }
      return res;
    }).then(function (r) {
      if (!r || r.status !== 'connected') throw { code: 'error', message: 'Could not connect to the server.' };
      showSteps(STEP_LABELS, 3);
      S.conn = {
        host: p.host, port: p.port, username: p.username,
        password: p.password, privateKey: p.privateKey, passphrase: p.passphrase,
        fingerprint: r.fingerprint, keyType: r.keyType
      };
      var saving = opts.remember ? saveVault(p, r.fingerprint) : Ssh.vaultClear();
      return Promise.resolve(saving).catch(function () { }).then(function () { return afterConnect(); });
    }).then(function () {
      setBusy(false);
      return true;
    }).catch(function (e) {
      setBusy(false);
      if (!$('screen-connect').classList.contains('active')) show('screen-connect');
      showConnError(e, p);
      return false;
    });
  }

  function afterConnect() {
    return Remote.status().then(function (st) {
      S.status = st;
      renderHome();
      renderSettings();
      if (st.setup !== 'done') {
        prepareSetupScreen();
        show('screen-setup');
      } else {
        enterMain();
      }
    });
  }

  function enterMain() {
    show('screen-main');
    showView(S.view || 'home');
  }

  function prefillForm(v) {
    $('host').value = v.host || '';
    $('user').value = v.username || 'root';
    $('port').value = v.port || 22;
    setAuthMode(v.authMode === 'key' ? 'key' : 'pass');
    if (v.authMode === 'key' && v.pemName) $('pemName').textContent = v.pemName + ' (saved)';
  }

  // ------------------------------------------------------------ startup / auto connect

  function startup() {
    Remote.attach();
    Ssh.addListener('shellData', function (e) {
      if (e.id === S.shellId && S.term) S.term.write(e.data);
    });
    Ssh.addListener('shellClosed', function (e) {
      if (e.id === S.shellId) {
        S.shellId = null;
        termOverlay('Session ended');
      }
    });

    Ssh.vaultLoad().then(function (r) {
      if (!r || !r.found || !r.data) { show('screen-connect'); return; }
      var v;
      try { v = JSON.parse(r.data); } catch (e) { show('screen-connect'); return; }
      if (!v.host) { show('screen-connect'); return; }
      prefillForm(v);
      if (v.authMode === 'key') { S.pem = v.privateKey || ''; S.pemName = v.pemName || ''; }
      $('splashText').textContent = 'Connecting to ' + v.host + '...';
      show('screen-splash');
      var p = {
        host: v.host, port: v.port || 22, username: v.username || 'root',
        password: v.password || '', privateKey: v.privateKey || '', passphrase: v.passphrase || '',
        trustedFingerprint: v.fingerprint || ''
      };
      connectFlow(p, { remember: true, auto: true }).then(function (ok) {
        if (!ok) show('screen-connect');
      });
    }).catch(function () { show('screen-connect'); });
  }

  // ------------------------------------------------------------ home

  function mb(n) { n = parseInt(n, 10); return isNaN(n) ? '-' : (n >= 1024 ? (n / 1024).toFixed(1) + ' GB' : n + ' MB'); }

  function setBadge(el, text, cls) {
    el.textContent = text;
    el.className = 'badge' + (cls ? ' ' + cls : '');
  }

  function renderHome() {
    var st = S.status;
    if (!st || !S.conn) return;
    $('connLine').textContent = S.conn.username + '@' + S.conn.host;
    $('osLine').textContent = (st.os || '-') + '  |  ' + (st.arch || '-');
    setBadge($('connBadge'), 'Connected', 'ok');

    var total = parseInt(st.ram_total_mb, 10), avail = parseInt(st.ram_avail_mb, 10);
    var used = total - avail;
    $('ramTxt').textContent = isNaN(total) ? '-' : mb(used) + ' used of ' + mb(total) + '  (' + mb(avail) + ' free)';
    var rp = isNaN(total) ? 0 : Math.round(used / total * 100);
    $('ramBar').style.width = rp + '%';
    $('ramBar').style.background = rp > 88 ? 'var(--bad)' : rp > 70 ? 'var(--warn)' : 'var(--ok)';
    $('swapTxt').textContent = mb(st.swap_total_mb) + ' total';

    var dt = parseInt(st.disk_total_gb, 10), df = parseInt(st.disk_free_gb, 10);
    $('diskTxt').textContent = isNaN(dt) ? '-' : (dt - df) + ' GB used of ' + dt + ' GB  (' + df + ' GB free)';
    var dp = isNaN(dt) ? 0 : Math.round((dt - df) / dt * 100);
    $('diskBar').style.width = dp + '%';
    $('diskBar').style.background = dp > 90 ? 'var(--bad)' : dp > 75 ? 'var(--warn)' : 'var(--ok)';

    $('nodeTxt').textContent = st.node && st.node !== 'none' ? st.node : 'not found';
    $('toolsTxt').textContent = (st.git || 'no') + ' / ' + (st.tmux === 'yes' ? 'yes' : 'no');

    var running = st.omniroute === 'running';
    var hasBin = st.omniroute_bin && st.omniroute_bin !== 'none';
    setBadge($('omniBadge'), running ? 'Running' : (hasBin ? 'Stopped' : 'Not installed'), running ? 'ok' : (hasBin ? 'warn' : 'bad'));
    $('omniStartBtn').classList.toggle('hidden', running || !hasBin);

    var done = st.setup === 'done';
    setBadge($('setupBadge'), done ? 'Done' : 'Not done', done ? 'ok' : 'warn');
    $('setupInfo').textContent = done
      ? 'Projects folder: ~/mobile-harness/projects (' + (st.projects || 0) + ' projects)'
      : 'Run setup once to prepare the VPS.';
    $('setupAgainBtn').textContent = done ? 'Run setup again' : 'Run setup';
  }

  function refreshHome(quiet) {
    if (!quiet) toast('Refreshing...', 1200);
    return Remote.status().then(function (st) {
      S.status = st;
      renderHome();
    }).catch(function (e) {
      setBadge($('connBadge'), 'Disconnected', 'bad');
      toast(errCode(e) === 'not_connected' ? 'Connection lost. Open Settings > Reconnect.' : errMsg(e), 3500);
    });
  }

  function startOmniroute() {
    var btn = $('omniStartBtn'), msg = $('omniMsg');
    btn.disabled = true; btn.textContent = 'Starting...';
    msg.classList.add('hidden');
    Remote.run('omniroute-start', 90000).then(function (r) {
      var out = (r.stdout || '').trim().split('\n').filter(Boolean);
      var last = (out[out.length - 1] || '').replace('##FAIL ', '');
      msg.textContent = last || 'Done';
      msg.classList.remove('hidden');
      return refreshHome(true);
    }).catch(function (e) {
      msg.textContent = errMsg(e);
      msg.classList.remove('hidden');
    }).then(function () {
      btn.disabled = false; btn.textContent = 'Start OmniRoute';
    });
  }

  // ------------------------------------------------------------ setup

  function prepareSetupScreen() {
    $('setupLog').classList.add('hidden');
    $('setupLog').textContent = '';
    $('setupStep').classList.add('hidden');
    $('setupError').classList.add('hidden');
    $('setupBtn').classList.remove('hidden');
    $('setupBtn').disabled = false;
    $('setupBtn').textContent = 'Start setup';
    $('setupContinue').classList.add('hidden');
    $('setupSkip').classList.remove('hidden');
  }

  function runSetup() {
    var log = $('setupLog'), stepEl = $('setupStep'), errEl = $('setupError');
    var buf = '', failed = '', done = false;
    log.textContent = '';
    log.classList.remove('hidden');
    stepEl.classList.remove('hidden');
    stepEl.textContent = 'Starting...';
    errEl.classList.add('hidden');
    $('setupBtn').disabled = true;
    $('setupBtn').textContent = 'Working...';
    $('setupSkip').classList.add('hidden');

    function handleLine(line) {
      if (line.indexOf('##STEP ') === 0) {
        stepEl.textContent = line.slice(7);
        log.textContent += '\n> ' + line.slice(7) + '\n';
      } else if (line.indexOf('##FAIL ') === 0) {
        failed = line.slice(7);
        log.textContent += '\n[!] ' + failed + '\n';
      } else if (line.indexOf('##DONE') === 0) {
        done = true;
      } else {
        log.textContent += line + '\n';
      }
      log.scrollTop = log.scrollHeight;
    }

    Remote.stream('setup', function (chunk) {
      buf += chunk;
      var parts = buf.split('\n');
      buf = parts.pop();
      parts.forEach(handleLine);
    }).then(function (code) {
      if (buf) handleLine(buf);
      if (done && code === 0) {
        stepEl.textContent = 'Setup complete';
        $('setupBtn').classList.add('hidden');
        $('setupContinue').classList.remove('hidden');
        return Remote.status().then(function (st) { S.status = st; renderHome(); });
      }
      throw { message: failed || ('Setup stopped (exit code ' + code + '). See the log above.') };
    }).catch(function (e) {
      stepEl.textContent = 'Setup failed';
      errEl.textContent = errMsg(e);
      errEl.classList.remove('hidden');
      $('setupBtn').disabled = false;
      $('setupBtn').textContent = 'Retry';
      $('setupSkip').classList.remove('hidden');
    });
  }

  // ------------------------------------------------------------ navigation

  function showView(name) {
    S.view = name;
    var map = { home: 'view-home', projects: 'view-soon', chat: 'view-soon', term: 'view-term', settings: 'view-settings' };
    var all = document.querySelectorAll('.view');
    for (var i = 0; i < all.length; i++) all[i].classList.remove('active');
    $(map[name]).classList.add('active');
    var btns = document.querySelectorAll('#nav button');
    for (var j = 0; j < btns.length; j++) btns[j].classList.toggle('on', btns[j].getAttribute('data-v') === name);

    if (name === 'projects') {
      $('soonTitle').textContent = 'Projects - coming in Phase 2';
      $('soonText').textContent = 'Create projects on your VPS, with git checkpoints and undo/accept.';
    } else if (name === 'chat') {
      $('soonTitle').textContent = 'Chat - coming in Phase 2';
      $('soonText').textContent = 'Claude Code through your OmniRoute combo, running fully on the VPS.';
    }
    if (name === 'term') setTimeout(ensureTerminal, 60);
    if (name === 'home') refreshHome(true);
  }

  // ------------------------------------------------------------ terminal

  var KEYS = {
    esc: '\x1b', tab: '\t', c: '\x03',
    left: '\x1b[D', down: '\x1b[B', up: '\x1b[A', right: '\x1b[C',
    pipe: '|', slash: '/', dash: '-', tilde: '~'
  };

  function termOverlay(text) {
    if (!text) { $('termOverlay').classList.add('hidden'); return; }
    $('termOverlayText').textContent = text;
    $('termOverlay').classList.remove('hidden');
  }

  function fitTerm() {
    if (!S.term || !S.fit) return;
    var el = $('terminal');
    if (!el.offsetWidth || !el.offsetHeight) return;
    try {
      S.fit.fit();
      if (S.shellId) Ssh.shellResize({ id: S.shellId, cols: S.term.cols, rows: S.term.rows }).catch(function () { });
    } catch (e) { }
  }

  function ensureTerminal() {
    if (!window.Terminal || !window.FitAddon) {
      termOverlay('Terminal files are missing from this build.');
      $('termReopen').classList.add('hidden');
      return;
    }
    if (!S.term) {
      S.term = new window.Terminal({
        fontSize: 13,
        cursorBlink: true,
        scrollback: 4000,
        fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
        theme: { background: '#000000', foreground: '#d7dae0', cursor: '#f28c52' }
      });
      S.fit = new window.FitAddon.FitAddon();
      S.term.loadAddon(S.fit);
      S.term.open($('terminal'));
      S.term.onData(onTermData);
      if (window.ResizeObserver) new ResizeObserver(function () { fitTerm(); }).observe($('terminal'));
      $('terminal').addEventListener('click', function () { S.term.focus(); });
    }
    fitTerm();
    if (!S.shellId) openShell();
    S.term.focus();
  }

  function openShell() {
    if (!S.term) return;
    termOverlay('');
    S.term.reset();
    fitTerm();
    var id = 't' + Date.now().toString(36);
    S.shellId = id;
    Ssh.shellOpen({ id: id, cols: S.term.cols || 80, rows: S.term.rows || 24 }).catch(function (e) {
      if (S.shellId === id) S.shellId = null;
      termOverlay(errCode(e) === 'not_connected' ? 'Not connected. Open Settings > Reconnect.' : errMsg(e));
    });
  }

  function sendToShell(data) {
    if (!S.shellId) return;
    Ssh.shellWrite({ id: S.shellId, data: data }).catch(function () { });
  }

  function onTermData(d) {
    if (S.ctrl && d.length === 1) {
      var ch = d.toUpperCase().charCodeAt(0);
      if (ch >= 64 && ch <= 95) d = String.fromCharCode(ch & 0x1f);
      S.ctrl = false;
      $('ctrlKey').classList.remove('on');
    }
    sendToShell(d);
  }

  // ------------------------------------------------------------ settings / reconnect

  function renderSettings() {
    if (!S.conn) { $('setConn').textContent = 'Not connected'; $('setFp').textContent = '-'; return; }
    $('setConn').textContent = S.conn.username + '@' + S.conn.host + ':' + S.conn.port;
    $('setFp').textContent = S.conn.fingerprint || '-';
  }

  function reconnect(silent) {
    if (!S.conn) { show('screen-connect'); return Promise.resolve(false); }
    if (silent) toast('Reconnecting...', 1800);
    var p = {
      host: S.conn.host, port: S.conn.port, username: S.conn.username,
      password: S.conn.password, privateKey: S.conn.privateKey, passphrase: S.conn.passphrase,
      trustedFingerprint: S.conn.fingerprint || ''
    };
    S.shellId = null;
    return Ssh.connect(p).then(function (r) {
      if (!r || r.status !== 'connected') throw { message: 'Could not reconnect' };
      toast('Reconnected', 1800);
      return refreshHome(true);
    }).catch(function (e) {
      setBadge($('connBadge'), 'Disconnected', 'bad');
      toast('Reconnect failed: ' + friendlyError(e), 4500);
    });
  }

  function checkAlive() {
    if (!S.conn || !$('screen-main').classList.contains('active')) return;
    Ssh.status().then(function (r) {
      if (r && !r.connected) reconnect(true);
    }).catch(function () { });
  }

  // ------------------------------------------------------------ wire up UI

  function wire() {
    $('tabPass').onclick = function () { setAuthMode('pass'); };
    $('tabKey').onclick = function () { setAuthMode('key'); };
    $('eye').onclick = function () {
      var f = $('pass');
      f.type = f.type === 'password' ? 'text' : 'password';
    };

    $('pemBtn').onclick = function () { $('pemFile').click(); };
    $('pemFile').onchange = function () {
      var f = this.files && this.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        S.pem = String(rd.result || '');
        S.pemName = f.name;
        $('pemName').textContent = f.name + ' (' + Math.round(f.size / 1024 * 10) / 10 + ' KB)';
        if (S.pem.indexOf('PRIVATE KEY') < 0) toast('This does not look like a private key file', 3500);
      };
      rd.onerror = function () { toast('Could not read the file'); };
      rd.readAsText(f);
    };

    $('connectBtn').onclick = function () {
      if (S.busy) return;
      var p = readForm();
      var bad = validateForm(p);
      if (bad) {
        $('connError').textContent = bad;
        $('connError').classList.remove('hidden');
        hideSteps();
        return;
      }
      connectFlow(p, { remember: $('remember').checked });
    };

    $('setupBtn').onclick = runSetup;
    $('setupContinue').onclick = enterMain;
    $('setupSkip').onclick = enterMain;
    $('setupAgainBtn').onclick = function () { prepareSetupScreen(); show('screen-setup'); };

    $('refreshBtn').onclick = function () { refreshHome(false); };
    $('omniStartBtn').onclick = startOmniroute;

    var navBtns = document.querySelectorAll('#nav button');
    for (var i = 0; i < navBtns.length; i++) {
      navBtns[i].onclick = function () { showView(this.getAttribute('data-v')); };
    }

    // terminal helper keys: pointerdown + preventDefault keeps the soft keyboard open
    var keyBtns = document.querySelectorAll('#keys button');
    for (var k = 0; k < keyBtns.length; k++) {
      keyBtns[k].addEventListener('pointerdown', function (ev) {
        ev.preventDefault();
        var key = this.getAttribute('data-k');
        if (key === 'ctrl') {
          S.ctrl = !S.ctrl;
          this.classList.toggle('on', S.ctrl);
          return;
        }
        sendToShell(KEYS[key] || '');
      });
    }
    $('termReopen').onclick = openShell;

    $('reconnectBtn').onclick = function () { reconnect(false); };
    $('disconnectBtn').onclick = function () {
      Ssh.disconnect().then(function () {
        S.shellId = null;
        setBadge($('connBadge'), 'Disconnected', 'bad');
        show('screen-connect');
      });
    };
    $('forgetBtn').onclick = function () {
      if (!window.confirm('Forget this VPS? Saved login details will be deleted from this phone.')) return;
      Ssh.disconnect().then(function () { return Ssh.vaultClear(); }).then(function () {
        S.conn = null; S.status = null; S.pem = ''; S.pemName = ''; S.shellId = null;
        $('host').value = ''; $('pass').value = ''; $('passphrase').value = '';
        $('pemName').textContent = 'No file selected';
        $('connError').classList.add('hidden');
        hideSteps();
        show('screen-connect');
      });
    };

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkAlive();
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    wire();
    startup();
  });
})();

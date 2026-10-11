// Thin wrapper around the native "SshBridge" plugin.
// Inside the APK -> real SSH. In a normal browser -> every call says it needs the app.
(function () {
  var cap = window.Capacitor;
  var native = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  window.IS_NATIVE = native;

  if (native) {
    window.Ssh = typeof cap.registerPlugin === 'function'
      ? cap.registerPlugin('SshBridge')
      : cap.Plugins.SshBridge;
    return;
  }

  var msg = 'SSH only works inside the installed Android app.';
  var names = ['connect', 'disconnect', 'status', 'exec', 'execStream', 'execCancel',
    'shellOpen', 'shellWrite', 'shellResize', 'shellClose', 'vaultSave', 'vaultLoad', 'vaultClear'];
  var mock = {};
  names.forEach(function (n) {
    mock[n] = function () {
      if (n === 'vaultLoad') return Promise.resolve({ found: false, data: '' });
      if (n === 'vaultClear' || n === 'vaultSave' || n === 'disconnect') return Promise.resolve();
      if (n === 'status') return Promise.resolve({ connected: false });
      return Promise.reject({ message: msg, code: 'not_native' });
    };
  });
  mock.addListener = function () { return Promise.resolve({ remove: function () { } }); };
  window.Ssh = mock;
})();

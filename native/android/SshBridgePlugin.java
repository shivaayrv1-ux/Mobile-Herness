package com.vikki.mhcloud;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.jcraft.jsch.ChannelExec;
import com.jcraft.jsch.ChannelShell;
import com.jcraft.jsch.HostKey;
import com.jcraft.jsch.HostKeyRepository;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.Session;
import com.jcraft.jsch.UIKeyboardInteractive;
import com.jcraft.jsch.UserInfo;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * MH Cloud - native SSH bridge.
 *
 * One SSH session at a time (the user's VPS). On top of it:
 *  - exec / execStream : run scripts on the VPS
 *  - shellOpen/Write/Resize/Close : interactive PTY terminal
 *  - vaultSave/Load/Clear : Android-Keystore (AES-256-GCM) encrypted credential storage
 *
 * Events sent to JS: execData, execExit, shellData, shellClosed
 */
@CapacitorPlugin(name = "SshBridge")
public class SshBridgePlugin extends Plugin {

    private static final String VAULT_ALIAS = "mhcloud_vault_key";
    private static final String VAULT_PREFS = "mhcloud_vault";

    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final Object lock = new Object();
    private Session session;
    private final Map<String, ChannelExec> execs = new ConcurrentHashMap<>();
    private final Map<String, ShellHandle> shells = new ConcurrentHashMap<>();

    // ---------------------------------------------------------------- connect

    @PluginMethod
    public void connect(final PluginCall call) {
        final String host = nz(call.getString("host")).trim();
        final Integer portObj = call.getInt("port", 22);
        final int port = portObj == null ? 22 : portObj;
        final String user = nz(call.getString("username")).trim();
        final String password = nz(call.getString("password"));
        final String privateKey = nz(call.getString("privateKey"));
        final String passphrase = nz(call.getString("passphrase"));
        final String trusted = nz(call.getString("trustedFingerprint")).trim();

        if (host.isEmpty()) {
            call.reject("Enter the VPS IP address", "bad_input");
            return;
        }
        if (user.isEmpty()) {
            call.reject("Enter the username", "bad_input");
            return;
        }
        final boolean useKey = !privateKey.trim().isEmpty();
        if (!useKey && password.isEmpty()) {
            call.reject("Enter a password or choose a .pem key file", "bad_input");
            return;
        }

        pool.execute(new Runnable() {
            @Override
            public void run() {
                closeAll();
                CapturingRepo repo = new CapturingRepo(trusted);
                Session s = null;
                try {
                    JSch jsch = new JSch();
                    if (useKey) {
                        byte[] pass = passphrase.isEmpty() ? null : passphrase.getBytes(StandardCharsets.UTF_8);
                        jsch.addIdentity("mh-key", normalizeKey(privateKey).getBytes(StandardCharsets.UTF_8), null, pass);
                    }
                    s = jsch.getSession(user, host, port);
                    s.setHostKeyRepository(repo);
                    s.setConfig("StrictHostKeyChecking", "yes");
                    if (useKey) {
                        s.setConfig("PreferredAuthentications", "publickey");
                    } else {
                        s.setConfig("PreferredAuthentications", "password,keyboard-interactive");
                        s.setPassword(password);
                        s.setUserInfo(new PwUserInfo(password));
                    }
                    s.setServerAliveInterval(15000);
                    s.setServerAliveCountMax(6);
                    s.connect(15000);

                    synchronized (lock) {
                        session = s;
                    }
                    JSObject ret = new JSObject();
                    ret.put("status", "connected");
                    ret.put("fingerprint", repo.fingerprint);
                    ret.put("keyType", repo.keyType);
                    call.resolve(ret);
                } catch (Throwable e) {
                    if (s != null) {
                        try { s.disconnect(); } catch (Throwable ignore) { }
                    }
                    if (repo.sawKey && repo.changed) {
                        call.reject("The server's fingerprint is different from the one you trusted earlier.", "host_changed");
                    } else if (repo.sawKey && !repo.matched) {
                        // first time seeing this server: let the user confirm the fingerprint
                        JSObject ret = new JSObject();
                        ret.put("status", "untrusted");
                        ret.put("fingerprint", repo.fingerprint);
                        ret.put("keyType", repo.keyType);
                        call.resolve(ret);
                    } else {
                        call.reject(msg(e), codeFor(e));
                    }
                }
            }
        });
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        pool.execute(new Runnable() {
            @Override
            public void run() {
                closeAll();
            }
        });
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        boolean ok;
        synchronized (lock) {
            ok = session != null && session.isConnected();
        }
        JSObject ret = new JSObject();
        ret.put("connected", ok);
        call.resolve(ret);
    }

    // ------------------------------------------------------------------- exec

    /** Run a script, wait for it to finish, return stdout/stderr/exitCode. */
    @PluginMethod
    public void exec(final PluginCall call) {
        final String command = nz(call.getString("command"));
        final Integer t = call.getInt("timeoutMs", 60000);
        final int timeoutMs = t == null ? 60000 : t;
        final Session s = requireSession(call);
        if (s == null) return;

        pool.execute(new Runnable() {
            @Override
            public void run() {
                ChannelExec ch = null;
                try {
                    ch = (ChannelExec) s.openChannel("exec");
                    ch.setCommand(wrap(command, false));
                    ch.setInputStream(null);
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    ByteArrayOutputStream err = new ByteArrayOutputStream();
                    ch.setOutputStream(out);
                    ch.setErrStream(err);
                    ch.connect(10000);
                    long end = System.currentTimeMillis() + timeoutMs;
                    while (!ch.isClosed()) {
                        if (System.currentTimeMillis() > end) {
                            call.reject("Command timed out", "timeout");
                            return;
                        }
                        Thread.sleep(50);
                    }
                    JSObject ret = new JSObject();
                    ret.put("stdout", new String(out.toByteArray(), StandardCharsets.UTF_8));
                    ret.put("stderr", new String(err.toByteArray(), StandardCharsets.UTF_8));
                    ret.put("exitCode", ch.getExitStatus());
                    call.resolve(ret);
                } catch (Throwable e) {
                    call.reject(msg(e), "exec_failed");
                } finally {
                    if (ch != null) ch.disconnect();
                }
            }
        });
    }

    /**
     * Start a script and stream its output (stdout+stderr merged) as "execData" events.
     * JS supplies its own id so no event can arrive before JS knows the id.
     * Resolves as soon as the command has started; "execExit" fires at the end.
     */
    @PluginMethod
    public void execStream(final PluginCall call) {
        final String id = nz(call.getString("id"));
        final String command = nz(call.getString("command"));
        if (id.isEmpty()) {
            call.reject("id is required", "bad_input");
            return;
        }
        final Session s = requireSession(call);
        if (s == null) return;

        pool.execute(new Runnable() {
            @Override
            public void run() {
                ChannelExec ch = null;
                boolean started = false;
                try {
                    ch = (ChannelExec) s.openChannel("exec");
                    ch.setCommand(wrap(command, true));
                    ch.setInputStream(null);
                    InputStream in = ch.getInputStream();
                    ch.connect(10000);
                    execs.put(id, ch);
                    started = true;
                    call.resolve();

                    InputStreamReader rd = new InputStreamReader(in, StandardCharsets.UTF_8);
                    char[] buf = new char[2048];
                    int n;
                    while ((n = rd.read(buf)) != -1) {
                        emit("execData", id, new String(buf, 0, n));
                    }
                    int waited = 0;
                    while (!ch.isClosed() && waited < 5000) {
                        Thread.sleep(50);
                        waited += 50;
                    }
                    emitExit(id, ch.getExitStatus());
                } catch (Throwable e) {
                    if (!started) {
                        call.reject(msg(e), "exec_failed");
                    } else {
                        emit("execData", id, "\n[connection error] " + msg(e) + "\n");
                        emitExit(id, -1);
                    }
                } finally {
                    execs.remove(id);
                    if (ch != null) ch.disconnect();
                }
            }
        });
    }

    @PluginMethod
    public void execCancel(PluginCall call) {
        ChannelExec ch = execs.get(nz(call.getString("id")));
        if (ch != null) ch.disconnect();
        call.resolve();
    }

    // ------------------------------------------------------------------ shell

    @PluginMethod
    public void shellOpen(final PluginCall call) {
        final String id = nz(call.getString("id"));
        final Integer c = call.getInt("cols", 80);
        final Integer r = call.getInt("rows", 24);
        final int cols = c == null ? 80 : c;
        final int rows = r == null ? 24 : r;
        if (id.isEmpty()) {
            call.reject("id is required", "bad_input");
            return;
        }
        final Session s = requireSession(call);
        if (s == null) return;

        pool.execute(new Runnable() {
            @Override
            public void run() {
                ShellHandle h = null;
                boolean started = false;
                try {
                    ChannelShell ch = (ChannelShell) s.openChannel("shell");
                    ch.setPtyType("xterm-256color");
                    ch.setPtySize(cols, rows, cols * 8, rows * 16);
                    InputStream in = ch.getInputStream();
                    OutputStream out = ch.getOutputStream();
                    ch.connect(10000);
                    h = new ShellHandle(ch, out);
                    shells.put(id, h);
                    started = true;
                    call.resolve();

                    InputStreamReader rd = new InputStreamReader(in, StandardCharsets.UTF_8);
                    char[] buf = new char[4096];
                    int n;
                    while ((n = rd.read(buf)) != -1) {
                        emit("shellData", id, new String(buf, 0, n));
                    }
                } catch (Throwable e) {
                    if (!started) {
                        call.reject(msg(e), "shell_failed");
                    }
                } finally {
                    if (h != null) {
                        shells.remove(id);
                        h.close();
                        JSObject o = new JSObject();
                        o.put("id", id);
                        notifyListeners("shellClosed", o);
                    }
                }
            }
        });
    }

    @PluginMethod
    public void shellWrite(PluginCall call) {
        final ShellHandle h = shells.get(nz(call.getString("id")));
        if (h == null) {
            call.reject("Terminal is not open", "no_shell");
            return;
        }
        final byte[] bytes = nz(call.getString("data")).getBytes(StandardCharsets.UTF_8);
        h.writer.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    h.out.write(bytes);
                    h.out.flush();
                } catch (IOException ignored) {
                }
            }
        });
        call.resolve();
    }

    @PluginMethod
    public void shellResize(PluginCall call) {
        final ShellHandle h = shells.get(nz(call.getString("id")));
        final Integer c = call.getInt("cols", 80);
        final Integer r = call.getInt("rows", 24);
        final int cols = c == null ? 80 : c;
        final int rows = r == null ? 24 : r;
        if (h != null) {
            pool.execute(new Runnable() {
                @Override
                public void run() {
                    try {
                        h.ch.setPtySize(cols, rows, cols * 8, rows * 16);
                    } catch (Throwable ignored) {
                    }
                }
            });
        }
        call.resolve();
    }

    @PluginMethod
    public void shellClose(PluginCall call) {
        ShellHandle h = shells.remove(nz(call.getString("id")));
        if (h != null) h.close();
        call.resolve();
    }

    // ------------------------------------------------------------------ vault

    @PluginMethod
    public void vaultSave(PluginCall call) {
        try {
            String data = nz(call.getString("data"));
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, vaultKey());
            byte[] iv = cipher.getIV();
            byte[] ct = cipher.doFinal(data.getBytes(StandardCharsets.UTF_8));
            String blob = Base64.encodeToString(iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP);
            getContext().getSharedPreferences(VAULT_PREFS, Context.MODE_PRIVATE)
                    .edit().putString("blob", blob).apply();
            call.resolve();
        } catch (Throwable e) {
            call.reject("Could not save securely: " + msg(e), "vault_error");
        }
    }

    @PluginMethod
    public void vaultLoad(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            String blob = getContext().getSharedPreferences(VAULT_PREFS, Context.MODE_PRIVATE)
                    .getString("blob", null);
            if (blob == null || !blob.contains(":")) {
                ret.put("found", false);
                ret.put("data", "");
                call.resolve(ret);
                return;
            }
            String[] parts = blob.split(":", 2);
            byte[] iv = Base64.decode(parts[0], Base64.NO_WRAP);
            byte[] ct = Base64.decode(parts[1], Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, vaultKey(), new GCMParameterSpec(128, iv));
            String data = new String(cipher.doFinal(ct), StandardCharsets.UTF_8);
            ret.put("found", true);
            ret.put("data", data);
            call.resolve(ret);
        } catch (Throwable e) {
            // key lost / data unreadable: treat as nothing saved
            ret.put("found", false);
            ret.put("data", "");
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void vaultClear(PluginCall call) {
        getContext().getSharedPreferences(VAULT_PREFS, Context.MODE_PRIVATE).edit().clear().apply();
        call.resolve();
    }

    private SecretKey vaultKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(VAULT_ALIAS)) {
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            kg.init(new KeyGenParameterSpec.Builder(
                    VAULT_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build());
            return kg.generateKey();
        }
        return (SecretKey) ks.getKey(VAULT_ALIAS, null);
    }

    // ---------------------------------------------------------------- helpers

    @Override
    protected void handleOnDestroy() {
        closeAll();
        super.handleOnDestroy();
    }

    private void closeAll() {
        for (ShellHandle h : shells.values()) h.close();
        shells.clear();
        for (ChannelExec ch : execs.values()) {
            try { ch.disconnect(); } catch (Throwable ignore) { }
        }
        execs.clear();
        Session old;
        synchronized (lock) {
            old = session;
            session = null;
        }
        if (old != null) {
            try { old.disconnect(); } catch (Throwable ignore) { }
        }
    }

    private Session requireSession(PluginCall call) {
        synchronized (lock) {
            if (session == null || !session.isConnected()) {
                call.reject("Not connected to the VPS", "not_connected");
                return null;
            }
            return session;
        }
    }

    private void emit(String event, String id, String data) {
        JSObject o = new JSObject();
        o.put("id", id);
        o.put("data", data);
        notifyListeners(event, o);
    }

    private void emitExit(String id, int code) {
        JSObject o = new JSObject();
        o.put("id", id);
        o.put("code", code);
        notifyListeners("execExit", o);
    }

    /** Wrap a script so it runs under bash no matter what the user's login shell is. */
    private static String wrap(String script, boolean mergeStderr) {
        String s = (mergeStderr ? "exec 2>&1\n" : "") + script;
        String b64 = Base64.encodeToString(s.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        return "bash -c \"$(printf %s '" + b64 + "' | base64 -d)\"";
    }

    private static String normalizeKey(String key) {
        String k = key.replace("\r\n", "\n").replace("\r", "\n").trim();
        return k + "\n";
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }

    private static String msg(Throwable e) {
        String m = e.getMessage();
        return (m == null || m.isEmpty()) ? e.getClass().getSimpleName() : m;
    }

    private static String codeFor(Throwable e) {
        Throwable c = e.getCause();
        String all = (String.valueOf(e.getMessage()) + " "
                + (c == null ? "" : String.valueOf(c.getMessage()) + " " + c.getClass().getSimpleName()))
                .toLowerCase(Locale.ROOT);
        if (all.contains("auth fail") || all.contains("auth cancel")) return "auth_failed";
        if (all.contains("passphrase") || all.contains("privatekey") || all.contains("invalid key")) return "key_error";
        if (all.contains("unknownhost") || all.contains("unresolved") || all.contains("unknown host")) return "unknown_host";
        if (all.contains("refused")) return "refused";
        if (all.contains("timeout") || all.contains("timed out")) return "timeout";
        if (all.contains("unreachable")) return "unreachable";
        return "error";
    }

    // ---------------------------------------------------------------- classes

    private static class ShellHandle {
        final ChannelShell ch;
        final OutputStream out;
        final ExecutorService writer = Executors.newSingleThreadExecutor();

        ShellHandle(ChannelShell ch, OutputStream out) {
            this.ch = ch;
            this.out = out;
        }

        void close() {
            try { writer.shutdownNow(); } catch (Throwable ignore) { }
            try { ch.disconnect(); } catch (Throwable ignore) { }
        }
    }

    /** Password / keyboard-interactive answers for servers that ask for them. */
    private static class PwUserInfo implements UserInfo, UIKeyboardInteractive {
        private final String pw;

        PwUserInfo(String pw) {
            this.pw = pw;
        }

        @Override public String getPassphrase() { return null; }
        @Override public String getPassword() { return pw; }
        @Override public boolean promptPassword(String message) { return true; }
        @Override public boolean promptPassphrase(String message) { return false; }
        @Override public boolean promptYesNo(String message) { return false; }
        @Override public void showMessage(String message) { }

        @Override
        public String[] promptKeyboardInteractive(String destination, String name, String instruction,
                                                  String[] prompt, boolean[] echo) {
            String[] answers = new String[prompt == null ? 0 : prompt.length];
            for (int i = 0; i < answers.length; i++) answers[i] = pw;
            return answers;
        }
    }

    /**
     * Trust-on-first-use host key check. No known_hosts file: JS keeps the trusted
     * fingerprint (encrypted) and passes it back in on every connect.
     */
    private static class CapturingRepo implements HostKeyRepository {
        private final String trusted;
        volatile boolean sawKey = false;
        volatile boolean matched = false;
        volatile boolean changed = false;
        volatile String fingerprint = "";
        volatile String keyType = "";

        CapturingRepo(String trusted) {
            this.trusted = trusted;
        }

        @Override
        public int check(String host, byte[] key) {
            sawKey = true;
            fingerprint = fingerprintOf(key);
            keyType = typeOf(key);
            if (trusted.isEmpty()) return NOT_INCLUDED;
            if (trusted.equals(fingerprint)) {
                matched = true;
                return OK;
            }
            changed = true;
            return CHANGED;
        }

        @Override public void add(HostKey hostkey, UserInfo ui) { }
        @Override public void remove(String host, String type) { }
        @Override public void remove(String host, String type, byte[] key) { }
        @Override public String getKnownHostsRepositoryID() { return "mhcloud"; }
        @Override public HostKey[] getHostKey() { return new HostKey[0]; }
        @Override public HostKey[] getHostKey(String host, String type) { return new HostKey[0]; }

        private static String fingerprintOf(byte[] key) {
            try {
                byte[] d = MessageDigest.getInstance("SHA-256").digest(key);
                return "SHA256:" + Base64.encodeToString(d, Base64.NO_WRAP | Base64.NO_PADDING);
            } catch (Exception e) {
                return "";
            }
        }

        private static String typeOf(byte[] key) {
            try {
                int len = ((key[0] & 0xff) << 24) | ((key[1] & 0xff) << 16) | ((key[2] & 0xff) << 8) | (key[3] & 0xff);
                return new String(key, 4, len, StandardCharsets.US_ASCII);
            } catch (Exception e) {
                return "unknown";
            }
        }
    }
}

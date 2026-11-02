// Annex Wi-Fi bridge — runs on the phone as the ADB shell user (via app_process).
// Accepts an end-to-end encrypted WebSocket from the Annex page and relays the
// decrypted byte stream to the local adbd TCP port (127.0.0.1:5555).
//
// Wire protocol (all WebSocket binary messages):
//   S->C  "ANX1" | serverSalt[16]
//   C->S  clientSalt[16] | GCM_c2s(ctr=0, "ANNEX-HELLO")
//   S->C  GCM_s2c(ctr=0, "OK") or GCM_s2c(ctr=0, "ERR:<reason>") then close
//   then  C->S GCM_c2s(ctr=1..), S->C GCM_s2c(ctr=1..) carrying raw ADB bytes.
// Keys: HKDF-SHA256(ikm=masterKey, salt=serverSalt|clientSalt, info="annex/1 c2s" | "annex/1 s2c").
// Nonce: 4 zero bytes | 64-bit big-endian counter (separate key per direction).
package annex;

import java.io.*;
import java.net.*;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.concurrent.atomic.AtomicInteger;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

public final class AnnexBridge {
    static final String VERSION = "1";
    static final byte[] MAGIC = {'A', 'N', 'X', '1'};
    static final int MAX_MESSAGE = 4 * 1024 * 1024;
    static final int MAX_SESSIONS = 4;
    static final SecureRandom RNG = new SecureRandom();
    static final AtomicInteger SESSIONS = new AtomicInteger();

    static byte[] master;
    static String targetHost = "127.0.0.1";
    static int targetPort = 5555;

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.out.println("usage: AnnexBridge <port> <keyfile> [targetPort] [pidfile]");
            System.exit(2);
        }
        int port = Integer.parseInt(args[0]);
        master = readKey(args[1]);
        if (args.length >= 3) targetPort = Integer.parseInt(args[2]);

        ServerSocket server = new ServerSocket();
        server.setReuseAddress(true);
        server.bind(new InetSocketAddress(port));
        if (args.length >= 4) writePid(args[3]);
        System.out.println("annex-bridge v" + VERSION + " listening on " + port + " -> " + targetHost + ":" + targetPort);
        System.out.flush();
        while (true) {
            final Socket client = server.accept();
            if (SESSIONS.get() >= MAX_SESSIONS) {
                closeQuietly(client);
                continue;
            }
            Thread t = new Thread(new SessionRunner(client), "annex-session");
            t.setDaemon(true);
            t.start();
        }
    }

    static final class SessionRunner implements Runnable {
        final Socket client;
        SessionRunner(Socket c) { client = c; }
        public void run() {
            SESSIONS.incrementAndGet();
            try {
                new Session(client).run();
            } catch (Throwable e) {
                System.out.println("session ended: " + e);
            } finally {
                SESSIONS.decrementAndGet();
                closeQuietly(client);
            }
        }
    }

    static final class Down implements Runnable {
        final Session s;
        InputStream tin;
        final Gcm enc;
        Down(Session s, InputStream tin, Gcm enc) { this.s = s; this.tin = tin; this.enc = enc; }
        public void run() {
            byte[] buf = new byte[65536];
            try {
                int n;
                while ((n = tin.read(buf)) > 0) {
                    byte[] c = enc.run(buf, 0, n);
                    s.sendFrame(0x2, c, 0, c.length);
                }
            } catch (Exception ignored) {
            } finally {
                try { s.sendClose(1000, "target closed"); } catch (Exception ignored) { }
                closeQuietly(s.ws);
            }
        }
    }

    /** /proc/self/stat starts with our pid — lets the page stop us without relying on process names. */
    static void writePid(String path) {
        try {
            FileInputStream in = new FileInputStream("/proc/self/stat");
            byte[] b = new byte[64];
            int n = in.read(b);
            in.close();
            String pid = new String(b, 0, Math.max(0, n), "US-ASCII").split(" ")[0];
            FileOutputStream out = new FileOutputStream(path);
            out.write((pid + "\n").getBytes("US-ASCII"));
            out.close();
        } catch (Exception ignored) {
        }
    }

    static byte[] readKey(String path) throws IOException {
        FileInputStream in = new FileInputStream(path);
        try {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] b = new byte[256];
            int n;
            while ((n = in.read(b)) > 0) buf.write(b, 0, n);
            String hex = new String(buf.toByteArray(), "US-ASCII").trim();
            if (hex.length() != 64) throw new IOException("key must be 64 hex chars");
            byte[] key = new byte[32];
            for (int i = 0; i < 32; i++) key[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
            return key;
        } finally {
            in.close();
        }
    }

    static void closeQuietly(Closeable c) {
        try { if (c != null) c.close(); } catch (IOException ignored) { }
    }

    // ---------------------------------------------------------------- crypto

    static byte[] hmac(byte[] key, byte[]... parts) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        for (byte[] p : parts) mac.update(p);
        return mac.doFinal();
    }

    static byte[] hkdf(byte[] ikm, byte[] salt, String info) throws Exception {
        byte[] prk = hmac(salt, ikm);
        return hmac(prk, info.getBytes("US-ASCII"), new byte[]{1}); // 32 bytes = one block
    }

    static final class Gcm {
        final SecretKeySpec key;
        long counter;
        final Cipher cipher;
        final int mode;

        Gcm(byte[] k, int mode) throws Exception {
            key = new SecretKeySpec(k, "AES");
            cipher = Cipher.getInstance("AES/GCM/NoPadding");
            this.mode = mode;
        }

        byte[] nonce() {
            byte[] n = new byte[12];
            long c = counter++;
            for (int i = 0; i < 8; i++) n[11 - i] = (byte) (c >>> (8 * i));
            return n;
        }

        byte[] run(byte[] data, int off, int len) throws Exception {
            cipher.init(mode, key, new GCMParameterSpec(128, nonce()));
            return cipher.doFinal(data, off, len);
        }
    }

    // ---------------------------------------------------------------- session

    static final class Session {
        final Socket ws;
        final InputStream in;
        final OutputStream out;
        Socket target;

        Session(Socket s) throws IOException {
            ws = s;
            ws.setTcpNoDelay(true);
            ws.setKeepAlive(true);
            in = new BufferedInputStream(s.getInputStream(), 65536);
            out = s.getOutputStream();
        }

        void run() throws Exception {
            ws.setSoTimeout(15000);
            if (!handshakeHttp()) return;

            byte[] serverSalt = new byte[16];
            RNG.nextBytes(serverSalt);
            byte[] hello = new byte[20];
            System.arraycopy(MAGIC, 0, hello, 0, 4);
            System.arraycopy(serverSalt, 0, hello, 4, 16);
            sendFrame(0x2, hello, 0, hello.length);

            byte[] first = readMessage();
            if (first == null || first.length < 16 + 16) { sendClose(4001, "bad hello"); return; }
            byte[] salt = new byte[32];
            System.arraycopy(serverSalt, 0, salt, 0, 16);
            System.arraycopy(first, 0, salt, 16, 16);
            Gcm dec = new Gcm(hkdf(master, salt, "annex/1 c2s"), Cipher.DECRYPT_MODE);
            Gcm enc = new Gcm(hkdf(master, salt, "annex/1 s2c"), Cipher.ENCRYPT_MODE);
            byte[] plain;
            try {
                plain = dec.run(first, 16, first.length - 16);
            } catch (Exception e) {
                System.out.println("auth failed from " + ws.getInetAddress());
                sendClose(4003, "auth failed");
                return;
            }
            if (!"ANNEX-HELLO".equals(new String(plain, "US-ASCII"))) { sendClose(4003, "auth failed"); return; }

            try {
                target = new Socket();
                target.setTcpNoDelay(true);
                target.connect(new InetSocketAddress(targetHost, targetPort), 5000);
            } catch (IOException e) {
                byte[] msg = ("ERR:adbd not reachable on port " + targetPort).getBytes("UTF-8");
                byte[] err = enc.run(msg, 0, msg.length);
                sendFrame(0x2, err, 0, err.length);
                sendClose(4004, "target");
                return;
            }
            byte[] ok = "OK".getBytes("US-ASCII");
            byte[] okEnc = enc.run(ok, 0, ok.length);
            sendFrame(0x2, okEnc, 0, okEnc.length);
            ws.setSoTimeout(0);
            System.out.println("session open from " + ws.getInetAddress());

            InputStream tin = target.getInputStream();
            OutputStream tout = target.getOutputStream();

            Thread down = new Thread(new Down(this, tin, enc), "annex-down");
            down.setDaemon(true);
            down.start();

            try {
                byte[] msg;
                while ((msg = readMessage()) != null) {
                    byte[] p = dec.run(msg, 0, msg.length);
                    tout.write(p);
                    tout.flush();
                }
            } finally {
                closeQuietly(target);
                closeQuietly(ws);
            }
        }

        boolean handshakeHttp() throws Exception {
            StringBuilder sb = new StringBuilder();
            int state = 0;
            while (state < 4) {
                int c = in.read();
                if (c < 0) return false;
                sb.append((char) c);
                if (sb.length() > 16384) return false;
                if ((state == 0 || state == 2) && c == '\r') state++;
                else if ((state == 1 || state == 3) && c == '\n') state++;
                else state = (c == '\r') ? 1 : 0;
            }
            String[] lines = sb.toString().split("\r\n");
            String key = null;
            boolean upgrade = false;
            for (int i = 1; i < lines.length; i++) {
                int colon = lines[i].indexOf(':');
                if (colon < 0) continue;
                String name = lines[i].substring(0, colon).trim().toLowerCase();
                String value = lines[i].substring(colon + 1).trim();
                if (name.equals("sec-websocket-key")) key = value;
                if (name.equals("upgrade") && value.toLowerCase().contains("websocket")) upgrade = true;
            }
            if (!upgrade || key == null) {
                String body = "{\"annex\":\"bridge\",\"v\":" + VERSION + "}";
                String resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n"
                        + "Content-Length: " + body.length() + "\r\nConnection: close\r\n\r\n" + body;
                out.write(resp.getBytes("US-ASCII"));
                out.flush();
                return false;
            }
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            byte[] digest = sha1.digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").getBytes("US-ASCII"));
            String resp = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                    + "Sec-WebSocket-Accept: " + base64(digest) + "\r\n\r\n";
            synchronized (out) {
                out.write(resp.getBytes("US-ASCII"));
                out.flush();
            }
            return true;
        }

        int readByte() throws IOException {
            int b = in.read();
            if (b < 0) throw new EOFException();
            return b;
        }

        void readFully(byte[] b, int off, int len) throws IOException {
            while (len > 0) {
                int n = in.read(b, off, len);
                if (n < 0) throw new EOFException();
                off += n;
                len -= n;
            }
        }

        /** Returns the next complete binary/text message, or null on close/EOF. */
        byte[] readMessage() throws IOException {
            ByteArrayOutputStream acc = null;
            while (true) {
                int b0, b1;
                try {
                    b0 = readByte();
                } catch (EOFException e) {
                    return null;
                }
                b1 = readByte();
                boolean fin = (b0 & 0x80) != 0;
                int opcode = b0 & 0x0f;
                boolean masked = (b1 & 0x80) != 0;
                long len = b1 & 0x7f;
                if (len == 126) {
                    len = (readByte() << 8) | readByte();
                } else if (len == 127) {
                    len = 0;
                    for (int i = 0; i < 8; i++) len = (len << 8) | readByte();
                }
                if (len > MAX_MESSAGE) throw new IOException("frame too large");
                byte[] mask = new byte[4];
                if (masked) readFully(mask, 0, 4);
                byte[] payload = new byte[(int) len];
                readFully(payload, 0, payload.length);
                if (masked) for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

                if (opcode == 0x8) { // close
                    try { sendClose(1000, ""); } catch (IOException ignored) { }
                    return null;
                } else if (opcode == 0x9) { // ping
                    sendFrame(0xA, payload, 0, payload.length);
                    continue;
                } else if (opcode == 0xA) { // pong
                    continue;
                }
                if (opcode == 0x1 || opcode == 0x2) {
                    if (fin && acc == null) return payload;
                    acc = new ByteArrayOutputStream();
                    acc.write(payload, 0, payload.length);
                } else if (opcode == 0x0 && acc != null) {
                    acc.write(payload, 0, payload.length);
                    if (acc.size() > MAX_MESSAGE) throw new IOException("message too large");
                }
                if (fin && acc != null) return acc.toByteArray();
            }
        }

        volatile boolean closeSent;

        void sendFrame(int opcode, byte[] data, int off, int len) throws IOException {
            if (closeSent) return; // nothing may follow a close frame
            if (opcode == 0x8) closeSent = true;
            byte[] header;
            if (len < 126) {
                header = new byte[]{(byte) (0x80 | opcode), (byte) len};
            } else if (len < 65536) {
                header = new byte[]{(byte) (0x80 | opcode), 126, (byte) (len >>> 8), (byte) len};
            } else {
                header = new byte[10];
                header[0] = (byte) (0x80 | opcode);
                header[1] = 127;
                for (int i = 0; i < 8; i++) header[9 - i] = (byte) (((long) len) >>> (8 * i));
            }
            synchronized (out) {
                out.write(header);
                out.write(data, off, len);
                out.flush();
            }
        }

        void sendClose(int code, String reason) throws IOException {
            byte[] r = reason.getBytes("UTF-8");
            byte[] p = new byte[2 + r.length];
            p[0] = (byte) (code >>> 8);
            p[1] = (byte) code;
            System.arraycopy(r, 0, p, 2, r.length);
            sendFrame(0x8, p, 0, p.length);
        }
    }

    static final char[] B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();

    static String base64(byte[] d) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < d.length; i += 3) {
            int b = (d[i] & 0xff) << 16;
            if (i + 1 < d.length) b |= (d[i + 1] & 0xff) << 8;
            if (i + 2 < d.length) b |= (d[i + 2] & 0xff);
            sb.append(B64[(b >>> 18) & 63]).append(B64[(b >>> 12) & 63]);
            sb.append(i + 1 < d.length ? B64[(b >>> 6) & 63] : '=');
            sb.append(i + 2 < d.length ? B64[b & 63] : '=');
        }
        return sb.toString();
    }
}

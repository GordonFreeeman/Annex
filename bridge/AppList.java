// Lists the phone's launcher entries (what the app drawer shows) with their real, localised
// labels and icons. Runs as the ADB shell user via app_process; prints one tab-separated line per app.
package annex;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.List;

public final class AppList {
    public static void main(String[] args) throws Exception {
        int size = args.length > 0 ? Integer.parseInt(args[0]) : 64;
        PrintStream out = new PrintStream(System.out, false, "UTF-8");
        try {
            android.os.Looper.prepareMainLooper();
        } catch (Throwable ignored) {
        }
        Context ctx = systemContext();
        PackageManager pm = ctx.getPackageManager();
        Intent intent = new Intent("android.intent.action.MAIN");
        intent.addCategory("android.intent.category.LAUNCHER");
        List<ResolveInfo> list = pm.queryIntentActivities(intent, 0);
        int n = 0;
        for (ResolveInfo ri : list) {
            try {
                ActivityInfo ai = ri.activityInfo;
                String label = clean(String.valueOf(ri.loadLabel(pm)));
                boolean system = ai.applicationInfo != null && (ai.applicationInfo.flags & 1) != 0;
                String icon = size > 0 ? icon(ri, pm, size) : "";
                out.println("APP\t" + ai.packageName + "\t" + ai.name + "\t" + (system ? 1 : 0) + "\t" + label + "\t" + icon);
                n++;
            } catch (Throwable e) {
                out.println("ERR\t" + clean(String.valueOf(e)));
            }
        }
        out.println("END\t" + n);
        out.flush();
        System.exit(0);
    }

    static String icon(ResolveInfo ri, PackageManager pm, int size) {
        try {
            Drawable d = ri.loadIcon(pm);
            Bitmap b = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(b);
            d.setBounds(0, 0, size, size);
            d.draw(c);
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            b.compress(Bitmap.CompressFormat.PNG, 100, o);
            return AnnexBridge.base64(o.toByteArray());
        } catch (Throwable e) {
            return "";
        }
    }

    static String clean(String s) {
        return s.replace('\t', ' ').replace('\n', ' ').replace('\r', ' ').trim();
    }

    /** Same technique as scrcpy's Workarounds: a fake ActivityThread to obtain the system context. */
    static Context systemContext() throws Exception {
        Class<?> at = Class.forName("android.app.ActivityThread");
        Constructor<?> ctor = at.getDeclaredConstructor();
        ctor.setAccessible(true);
        Object thread = ctor.newInstance();
        Field cur = at.getDeclaredField("sCurrentActivityThread");
        cur.setAccessible(true);
        cur.set(null, thread);
        Field sys = at.getDeclaredField("mSystemThread");
        sys.setAccessible(true);
        sys.setBoolean(thread, true);
        Method get = at.getDeclaredMethod("getSystemContext");
        get.setAccessible(true);
        return (Context) get.invoke(thread);
    }
}

package pk.afford.device;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.view.View;
import android.widget.RemoteViews;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * Snapchat-style alerts drawn by the app: the person's round photo (or initials), alerts stacked by
 * person, the Afford chime, and buttons (Approve / Decline for requests, View payslip, Open).
 * After showing, tells the server it arrived, so the server doesn't send the plain backup alert.
 */
public class AffordRich {

    static final String ACTION = "pk.afford.device.ALERT_ACTION";

    static void show(Context ctx, Map<String, String> d) {
        SharedPreferences p = ctx.getSharedPreferences(AffordNotifyWorker.PREFS, Context.MODE_PRIVATE);
        String id = val(d, "id", String.valueOf(System.currentTimeMillis()));
        String title = val(d, "title", "");
        String body = val(d, "body", "");
        String channel = val(d, "channel", AffordNotifyWorker.CHANNEL);
        String person = val(d, "person", "");
        String personName = val(d, "personName", "");
        String actions = val(d, "actions", "");
        String ref = val(d, "ref", "");
        boolean ur = "ur".equals(val(d, "lang", p.getString("lang", "en")));

        AffordNotifyWorker.ensureChannel(ctx);
        Bitmap face = null;
        if (!person.isEmpty() && "admin".equals(p.getString("kind", ""))) face = fetchPhoto(p, "/api/admin/employees/" + person + "/photo");
        if (face == null && !personName.isEmpty()) face = initials(personName);
        if (face == null) face = appIcon(ctx);

        String group = person.isEmpty() ? channel : "p-" + person;
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_afford_notify)
            .setColor(0xFFC62032)
            .setContentTitle(title)
            .setContentText(firstLine(body))
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory("afford_reminders2".equals(channel) ? NotificationCompat.CATEGORY_REMINDER : NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setGroup(group)
            .setContentIntent(openApp(ctx, id));
        JSONObject card = null;
        try {
            String cj = val(d, "card", "");
            if (!cj.isEmpty()) card = new JSONObject(cj);
        } catch (Exception ignored) { /* plain style */ }

        if (card != null) {
            // Design A "Action card": photo with red ring, name, role · code, label, details box, big buttons
            Bitmap ph = face != null ? round(face) : null;
            b.setCustomContentView(cardSmall(ctx, card, ph));
            b.setCustomBigContentView(cardBig(ctx, card, ph, id, ref, actions, ur));
            b.setCustomHeadsUpContentView(cardBig(ctx, card, ph, id, ref, actions, ur));
            b.setStyle(new NotificationCompat.DecoratedCustomViewStyle());
        } else if (face != null) {
            b.setLargeIcon(round(face));
        }

        if (card != null) {
            // buttons are inside the card
        } else if ("decide".equals(actions) && !ref.isEmpty()) {
            b.addAction(0, ur ? "منظور" : "Approve", actionIntent(ctx, id, ref, true));
            b.addAction(0, ur ? "نامنظور" : "Decline", actionIntent(ctx, id, ref, false));
        } else if ("payslip".equals(actions)) {
            b.addAction(0, ur ? "پے سلپ دیکھیں" : "View payslip", openApp(ctx, id + "-a"));
        } else if ("open".equals(actions)) {
            b.addAction(0, ur ? "کھولیں" : "Open", openApp(ctx, id + "-a"));
        }

        try {
            NotificationManagerCompat nm = NotificationManagerCompat.from(ctx);
            nm.notify(id, 0, b.build());
            // summary keeps several alerts from one person stacked together
            NotificationCompat.Builder sum = new NotificationCompat.Builder(ctx, channel)
                .setSmallIcon(R.drawable.ic_afford_notify)
                .setColor(0xFFC62032)
                .setContentTitle(personName.isEmpty() ? title : personName)
                .setGroup(group)
                .setGroupSummary(true)
                .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
                .setAutoCancel(true)
                .setContentIntent(openApp(ctx, group));
            nm.notify("sum-" + group, 0, sum.build());
        } catch (SecurityException ignored) {
            // notifications switched off by the user
        }
        ack(p, id);
    }

    // ---------------------------------------------------------------- action card

    static final String[] CHIPS = { "amber", "green", "blue", "red" };

    static void setChip(RemoteViews v, JSONObject card) {
        String color = card.optString("color", "blue");
        String label = card.optString("label", "");
        boolean found = false;
        for (String c : CHIPS) if (c.equals(color)) found = true;
        if (!found) color = "blue";
        int[] ids = { R.id.af_chip_amber, R.id.af_chip_green, R.id.af_chip_blue, R.id.af_chip_red };
        for (int i = 0; i < CHIPS.length; i++) {
            boolean on = CHIPS[i].equals(color) && !label.isEmpty();
            v.setViewVisibility(ids[i], on ? View.VISIBLE : View.GONE);
            if (on) v.setTextViewText(ids[i], label);
        }
    }

    static void setHead(RemoteViews v, JSONObject card, Bitmap photo) {
        if (photo != null) v.setImageViewBitmap(R.id.af_photo, photo);
        else v.setViewVisibility(R.id.af_photo, View.GONE);
        v.setTextViewText(R.id.af_name, card.optString("name", ""));
        setChip(v, card);
    }

    static RemoteViews cardSmall(Context ctx, JSONObject card, Bitmap photo) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.afford_card_small);
        setHead(v, card, photo);
        return v;
    }

    static RemoteViews cardBig(Context ctx, JSONObject card, Bitmap photo, String id, String ref, String actions, boolean ur) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), R.layout.afford_card_big);
        setHead(v, card, photo);
        String sub = card.optString("sub", "");
        if (sub.isEmpty()) v.setViewVisibility(R.id.af_sub, View.GONE);
        else v.setTextViewText(R.id.af_sub, sub);

        String text = card.optString("text", "");
        if (!text.isEmpty()) {
            v.setViewVisibility(R.id.af_text, View.VISIBLE);
            v.setTextViewText(R.id.af_text, text);
        }

        JSONArray rows = card.optJSONArray("rows");
        int n = 0;
        if (rows != null) {
            for (int i = 0; i < rows.length() && n < 4; i++) {
                JSONArray r = rows.optJSONArray(i);
                if (r == null || r.length() < 2) continue;
                RemoteViews row = new RemoteViews(ctx.getPackageName(), R.layout.afford_card_row);
                row.setTextViewText(R.id.af_k, r.optString(0, ""));
                row.setTextViewText(R.id.af_v, r.optString(1, ""));
                v.addView(R.id.af_box, row);
                n++;
            }
        }
        if (n == 0) v.setViewVisibility(R.id.af_box, View.GONE);

        if ("decide".equals(actions) && !ref.isEmpty()) {
            v.setTextViewText(R.id.af_ok, ur ? "✓ منظور" : "✓ Approve");
            v.setTextViewText(R.id.af_no, ur ? "✕ نامنظور" : "✕ Decline");
            v.setOnClickPendingIntent(R.id.af_ok, actionIntent(ctx, id, ref, true));
            v.setOnClickPendingIntent(R.id.af_no, actionIntent(ctx, id, ref, false));
        } else if ("payslip".equals(actions) || "open".equals(actions)) {
            String t = "payslip".equals(actions) ? (ur ? "پے سلپ دیکھیں" : "View payslip") : (ur ? "کھولیں" : "Open");
            v.setTextViewText(R.id.af_ok, t);
            v.setOnClickPendingIntent(R.id.af_ok, openApp(ctx, id + "-a"));
            v.setViewVisibility(R.id.af_no, View.GONE);
        } else {
            v.setViewVisibility(R.id.af_btns, View.GONE);
        }
        return v;
    }

    // ---------------------------------------------------------------- pieces

    static String val(Map<String, String> d, String k, String dflt) {
        String v = d.get(k);
        return v == null || v.isEmpty() ? dflt : v;
    }

    static String firstLine(String s) {
        int i = s.indexOf('\n');
        return i < 0 ? s : s.substring(0, i);
    }

    static PendingIntent openApp(Context ctx, String key) {
        Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (open == null) open = new Intent();
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(ctx, key.hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static PendingIntent actionIntent(Context ctx, String id, String ref, boolean approve) {
        Intent i = new Intent(ctx, AffordActionReceiver.class).setAction(ACTION)
            .putExtra("id", id).putExtra("ref", ref).putExtra("approve", approve);
        return PendingIntent.getBroadcast(ctx, (id + (approve ? "+" : "-")).hashCode(), i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static HttpURLConnection open(SharedPreferences p, String path, String method) throws Exception {
        String base = p.getString("base", null);
        if (base == null) throw new IllegalStateException("not logged in");
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        c.setConnectTimeout(6000);
        c.setReadTimeout(8000);
        c.setRequestMethod(method);
        String tk = p.getString("token", null);
        if (tk != null) c.setRequestProperty("authorization", "Bearer " + tk);
        String dev = p.getString("deviceId", null);
        if (dev != null) c.setRequestProperty("x-device-id", dev);
        return c;
    }

    static int postJson(SharedPreferences p, String path, JSONObject body) {
        HttpURLConnection c = null;
        try {
            c = open(p, path, "POST");
            c.setDoOutput(true);
            c.setRequestProperty("content-type", "application/json");
            try (OutputStream o = c.getOutputStream()) { o.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
            return c.getResponseCode();
        } catch (Exception e) {
            return 0;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    static void ack(SharedPreferences p, String id) {
        String push = p.getString("pushToken", null);
        if (push == null) return;
        try {
            postJson(p, "/api/push-ack", new JSONObject().put("token", push).put("id", id));
        } catch (Exception ignored) { /* the server sends the plain backup alert */ }
    }

    static Bitmap fetchPhoto(SharedPreferences p, String path) {
        HttpURLConnection c = null;
        try {
            c = open(p, path, "GET");
            if (c.getResponseCode() != 200) return null;
            try (InputStream in = c.getInputStream()) { return BitmapFactory.decodeStream(in); }
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    static Bitmap round(Bitmap src) {
        int s = Math.min(src.getWidth(), src.getHeight());
        Bitmap sq = Bitmap.createBitmap(src, (src.getWidth() - s) / 2, (src.getHeight() - s) / 2, s, s);
        // keep the alert small: the photo is copied into several views and must fit Android's IPC limit
        if (s > 160) { sq = Bitmap.createScaledBitmap(sq, 160, 160, true); s = 160; }
        Bitmap out = Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(out);
        Paint pt = new Paint(Paint.ANTI_ALIAS_FLAG);
        pt.setShader(new BitmapShader(sq, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP));
        cv.drawCircle(s / 2f, s / 2f, s / 2f, pt);
        return out;
    }
        pt.setShader(new BitmapShader(sq, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP));
        cv.drawCircle(s / 2f, s / 2f, s / 2f, pt);
        return out;
    }

    /** Round initials badge in the store red, like a chat app shows someone without a photo. */
    static Bitmap initials(String name) {
        String[] w = name.trim().split("\\s+");
        String ini = (w.length > 0 && !w[0].isEmpty() ? w[0].substring(0, 1) : "?")
            + (w.length > 1 && !w[1].isEmpty() ? w[1].substring(0, 1) : "");
        int s = 192;
        Bitmap out = Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(out);
        Paint bg = new Paint(Paint.ANTI_ALIAS_FLAG);
        bg.setColor(0xFFC62032);
        cv.drawCircle(s / 2f, s / 2f, s / 2f, bg);
        Paint tx = new Paint(Paint.ANTI_ALIAS_FLAG);
        tx.setColor(Color.WHITE);
        tx.setTextSize(s * 0.4f);
        tx.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
        tx.setTextAlign(Paint.Align.CENTER);
        Rect r = new Rect();
        String t = ini.toUpperCase();
        tx.getTextBounds(t, 0, t.length(), r);
        cv.drawText(t, s / 2f, s / 2f + r.height() / 2f, tx);
        return out;
    }

    static Bitmap appIcon(Context ctx) {
        try {
            Drawable dr = ctx.getPackageManager().getApplicationIcon(ctx.getPackageName());
            Bitmap out = Bitmap.createBitmap(192, 192, Bitmap.Config.ARGB_8888);
            Canvas cv = new Canvas(out);
            dr.setBounds(0, 0, 192, 192);
            dr.draw(cv);
            return out;
        } catch (Exception e) {
            return null;
        }
    }
}

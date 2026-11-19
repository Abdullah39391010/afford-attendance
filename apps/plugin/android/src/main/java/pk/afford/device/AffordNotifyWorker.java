package pk.afford.device;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.work.Worker;
import androidx.work.WorkManager;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * Runs about every 15 minutes (Android decides the exact time) and asks the server
 * whether there is anything new: new requests for admins, decided requests for staff.
 */
public class AffordNotifyWorker extends Worker {

    static final String PREFS = "afford_notify";
    static final String WORK = "afford-notify";
    static final String CHANNEL = "afford_alerts";

    public AffordNotifyWorker(@NonNull Context ctx, @NonNull WorkerParameters params) {
        super(ctx, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String base = p.getString("base", null);
        String token = p.getString("token", null);
        String kind = p.getString("kind", "admin");
        if (base == null || token == null) return Result.success();
        HttpURLConnection c = null;
        try {
            String path = "emp".equals(kind) ? "/api/emp/notify" : "/api/admin/notify";
            String url = base + path + "?since=" + p.getLong("since", 0) + "&lang=" + URLEncoder.encode(p.getString("lang", "en"), "UTF-8");
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(20000);
            c.setRequestProperty("authorization", "Bearer " + token);
            String dev = p.getString("deviceId", null);
            if (dev != null) c.setRequestProperty("x-device-id", dev);
            int code = c.getResponseCode();
            if (code == 401) {
                // logged out or phone reset: stop checking
                p.edit().clear().apply();
                WorkManager.getInstance(ctx).cancelUniqueWork(WORK);
                return Result.success();
            }
            if (code != 200) return Result.retry();
            StringBuilder sb = new StringBuilder();
            try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) sb.append(line);
            }
            JSONObject o = new JSONObject(sb.toString());
            JSONArray items = o.optJSONArray("items");
            if (items != null) for (int i = 0; i < items.length(); i++) {
                JSONObject it = items.getJSONObject(i);
                show(ctx, it.optString("id", String.valueOf(i)), it.optString("title"), it.optString("body"));
            }
            p.edit().putLong("since", o.optLong("since", p.getLong("since", 0))).apply();
            return Result.success();
        } catch (Exception e) {
            return Result.retry();
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** Alert types, each its own channel so people can mute one kind in phone settings. Ids match the server (push.js channelFor). */
    static final String[][] CHANNELS = {
        // id, English name, Urdu name, description, importance (4 = high, 3 = default)
        {"afford_alerts", "Requests", "درخواستیں", "New requests and answers to requests", "4"},
        {"afford_reminders", "Shift reminders", "شفٹ یاد دہانی", "Shift starts soon, forgot to check out", "4"},
        {"afford_salary", "Salary & payments", "تنخواہ اور ادائیگیاں", "Salary paid, bonus, advance, fines", "4"},
        {"afford_news", "Announcements", "اعلانات", "Holidays, duty roster, notes from the store", "3"},
        {"afford_reports", "Owner reports", "مالک کی رپورٹس", "Daily summary, approvals, backups, server", "3"},
    };

    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        boolean ur = "ur".equals(java.util.Locale.getDefault().getLanguage())
            || "ur".equals(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("lang", ""));
        for (String[] c : CHANNELS) {
            NotificationChannel ch = nm.getNotificationChannel(c[0]);
            if (ch == null) {
                ch = new NotificationChannel(c[0], ur ? c[2] : c[1], Integer.parseInt(c[4]));
                ch.enableVibration(true);
                ch.enableLights(true);
                ch.setLightColor(0xFFC62032);
                ch.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
                ch.setSound(android.media.RingtoneManager.getDefaultUri(android.media.RingtoneManager.TYPE_NOTIFICATION),
                    new android.media.AudioAttributes.Builder().setUsage(android.media.AudioAttributes.USAGE_NOTIFICATION)
                        .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            } else {
                ch.setName(ur ? c[2] : c[1]); // only the name and description can change after creation
            }
            ch.setDescription(c[3]);
            nm.createNotificationChannel(ch);
        }
        if (nm.getNotificationChannel("afford_requests") != null) nm.deleteNotificationChannel("afford_requests");
    }

    static void show(Context ctx, String id, String title, String body) { show(ctx, id, title, body, CHANNEL); }

    static void show(Context ctx, String id, String title, String body, String channel) {
        ensureChannel(ctx);
        if (channel == null || channel.isEmpty()) channel = CHANNEL;
        Intent open = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (open == null) open = new Intent();
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, id.hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_afford_notify)
            .setColor(0xFFC62032)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory("afford_reminders".equals(channel) ? NotificationCompat.CATEGORY_REMINDER : NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(pi);
        try {
            // Same tag + id 0 as alerts that Android shows straight from Firebase, so one request never shows twice.
            NotificationManagerCompat.from(ctx).notify(id, 0, b.build());
        } catch (SecurityException ignored) {
            // notifications not allowed by the user
        }
    }
}

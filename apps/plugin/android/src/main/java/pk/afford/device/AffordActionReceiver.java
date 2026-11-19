package pk.afford.device;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import org.json.JSONObject;

/** Approve / Decline tapped on a request alert: sends the answer with the logged-in admin's session. */
public class AffordActionReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (!AffordRich.ACTION.equals(intent.getAction())) return;
        final String id = intent.getStringExtra("id");
        final String ref = intent.getStringExtra("ref");
        final boolean approve = intent.getBooleanExtra("approve", false);
        if (id == null || ref == null) return;
        final PendingResult pending = goAsync();
        final Context app = ctx.getApplicationContext();
        new Thread(() -> {
            SharedPreferences p = app.getSharedPreferences(AffordNotifyWorker.PREFS, Context.MODE_PRIVATE);
            boolean ur = "ur".equals(p.getString("lang", "en"));
            int code;
            try {
                code = AffordRich.postJson(p, "/api/admin/requests/" + ref + "/decide", new JSONObject().put("approve", approve));
            } catch (Exception e) {
                code = 0;
            }
            String title;
            String text;
            if (code == 200) {
                title = approve ? (ur ? "منظور کر دی گئی ✓" : "Approved ✓") : (ur ? "نامنظور کر دی گئی" : "Declined");
                text = ur ? "ملازم کو بتا دیا گیا ہے۔" : "The employee has been told.";
            } else if (code == 400) {
                title = ur ? "پہلے ہی فیصلہ ہو چکا" : "Already decided";
                text = ur ? "یہ درخواست پہلے ہی منظور یا نامنظور ہو چکی ہے۔" : "Someone already answered this request.";
            } else {
                title = ur ? "نہیں ہو سکا" : "Couldn't send";
                text = ur ? "ایپ کھول کر دوبارہ کوشش کریں۔" : "Open the app and try again.";
            }
            try {
                NotificationCompat.Builder b = new NotificationCompat.Builder(app, AffordNotifyWorker.CHANNEL)
                    .setSmallIcon(R.drawable.ic_afford_notify)
                    .setColor(0xFFC62032)
                    .setContentTitle(title)
                    .setContentText(text)
                    .setOnlyAlertOnce(true)
                    .setSilent(true)
                    .setAutoCancel(true)
                    .setContentIntent(AffordRich.openApp(app, id));
                if (code == 200) b.setTimeoutAfter(4000);
                NotificationManagerCompat.from(app).notify(id, 0, b.build());
            } catch (SecurityException ignored) {
                // notifications off
            }
            pending.finish();
        }).start();
    }
}

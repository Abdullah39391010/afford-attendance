package pk.afford.device;

import android.content.Context;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/** Instant push from the server (Firebase). Shows the alert with sound, also on the lock screen. */
public class AffordFcmService extends FirebaseMessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage msg) {
        Map<String, String> d = msg.getData();
        if ("1".equals(d.get("rich")) && d.get("title") != null) {
            AffordRich.show(getApplicationContext(), d);
            return;
        }
        String title = d.get("title");
        String body = d.get("body");
        if (title == null && msg.getNotification() != null) {
            title = msg.getNotification().getTitle();
            body = msg.getNotification().getBody();
        }
        if (title == null) return;
        String id = d.get("id") != null ? d.get("id") : String.valueOf(System.currentTimeMillis());
        AffordNotifyWorker.show(getApplicationContext(), id, title, body == null ? "" : body, d.get("channel"));
    }

    @Override
    public void onNewToken(@NonNull String token) {
        getApplicationContext().getSharedPreferences(AffordNotifyWorker.PREFS, Context.MODE_PRIVATE)
            .edit().putString("pushToken", token).putBoolean("pushTokenNew", true).apply();
    }
}

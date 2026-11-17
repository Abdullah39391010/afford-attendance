package pk.afford.device;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.pm.PackageInfo;
import android.os.CancellationSignal;
import android.os.Environment;
import android.provider.MediaStore;
import android.location.Location;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.content.pm.PackageInfoCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.common.api.ResolvableApiException;
import com.google.android.gms.location.CurrentLocationRequest;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.LocationSettingsRequest;
import com.google.android.gms.location.Priority;
import com.google.android.gms.tasks.CancellationTokenSource;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.concurrent.Executor;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Afford custom plugin: device id, GPS (with "turn on location" prompt and fake-GPS detection),
 * fingerprint/face unlock, encrypted storage, share/print files and keep-screen-on for the kiosk.
 */
@CapacitorPlugin(
    name = "AffordDevice",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA })
    }
)
public class AffordDevicePlugin extends Plugin {

    private static final String KEY_ALIAS = "afford_secure_key";
    private static final String PREFS = "afford_secure";

    private FusedLocationProviderClient fused;
    private ActivityResultLauncher<IntentSenderRequest> gpsLauncher;
    private PluginCall pendingGpsCall;
    private boolean pendingGpsThenLocate;
    private WebView printWebView;

    @Override
    public void load() {
        // Android back button: the web app decides (close a sheet, go back a page, or go home).
        getActivity().runOnUiThread(() -> getActivity().getOnBackPressedDispatcher().addCallback(getActivity(), new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (hasListeners("backButton")) notifyListeners("backButton", new JSObject());
                else getActivity().moveTaskToBack(true);
            }
        }));
        fused = LocationServices.getFusedLocationProviderClient(getContext());
        gpsLauncher = getActivity().registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), result -> {
            PluginCall call = pendingGpsCall;
            boolean thenLocate = pendingGpsThenLocate;
            pendingGpsCall = null;
            if (call == null) return;
            if (result.getResultCode() == Activity.RESULT_OK) {
                if (thenLocate) locate(call);
                else {
                    JSObject r = new JSObject();
                    r.put("enabled", true);
                    call.resolve(r);
                }
            } else {
                call.reject("Location (GPS) is turned off", "GPS_OFF");
            }
        });
    }

    // ------------------------------------------------------------------ device info
    @PluginMethod
    public void getInfo(PluginCall call) {
        JSObject r = new JSObject();
        String id = Settings.Secure.getString(getContext().getContentResolver(), Settings.Secure.ANDROID_ID);
        r.put("deviceId", "a-" + (id == null ? "unknown" : id));
        r.put("model", Build.MODEL);
        r.put("manufacturer", Build.MANUFACTURER);
        r.put("osVersion", Build.VERSION.RELEASE);
        r.put("platform", "android");
        try {
            PackageInfo pi = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            r.put("appVersion", pi.versionName);
            r.put("appBuild", PackageInfoCompat.getLongVersionCode(pi));
        } catch (Exception ignored) {
        }
        call.resolve(r);
    }

    // ------------------------------------------------------------------ location
    @PluginMethod
    public void getLocation(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "locationPermsCallback");
            return;
        }
        checkGps(call, true);
    }

    @PluginMethod
    public void ensureGps(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "ensureGpsPermsCallback");
            return;
        }
        checkGps(call, false);
    }

    @PermissionCallback
    private void locationPermsCallback(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED) checkGps(call, true);
        else call.reject("Location permission denied", "PERMISSION_DENIED");
    }

    @PermissionCallback
    private void ensureGpsPermsCallback(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED) checkGps(call, false);
        else call.reject("Location permission denied", "PERMISSION_DENIED");
    }

    private void checkGps(PluginCall call, boolean thenLocate) {
        LocationRequest req = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 1000).build();
        LocationSettingsRequest settingsReq = new LocationSettingsRequest.Builder().addLocationRequest(req).setAlwaysShow(true).build();
        LocationServices.getSettingsClient(getActivity())
            .checkLocationSettings(settingsReq)
            .addOnSuccessListener(r -> {
                if (thenLocate) locate(call);
                else {
                    JSObject o = new JSObject();
                    o.put("enabled", true);
                    call.resolve(o);
                }
            })
            .addOnFailureListener(e -> {
                if (e instanceof ResolvableApiException) {
                    try {
                        // Shows Android's own "Turn on location?" dialog
                        IntentSenderRequest isr = new IntentSenderRequest.Builder(((ResolvableApiException) e).getResolution()).build();
                        pendingGpsCall = call;
                        pendingGpsThenLocate = thenLocate;
                        gpsLauncher.launch(isr);
                        return;
                    } catch (Exception ignored) {
                    }
                }
                call.reject("Location (GPS) is turned off", "GPS_OFF");
            });
    }

    private void locate(PluginCall call) {
        final int timeout = call.getInt("timeoutMs", 20000);
        final boolean[] done = { false };
        final CancellationTokenSource cts = new CancellationTokenSource();
        Handler handler = new Handler(Looper.getMainLooper());
        handler.postDelayed(() -> {
            if (done[0]) return;
            done[0] = true;
            cts.cancel();
            call.reject("Could not get a GPS fix. Go near a door or window and try again.", "NO_FIX");
        }, timeout);
        try {
            CurrentLocationRequest req = new CurrentLocationRequest.Builder()
                .setPriority(Priority.PRIORITY_HIGH_ACCURACY)
                .setMaxUpdateAgeMillis(15000)
                .setDurationMillis(timeout)
                .build();
            fused.getCurrentLocation(req, cts.getToken())
                .addOnSuccessListener(loc -> {
                    if (done[0]) return;
                    done[0] = true;
                    if (loc == null) {
                        call.reject("Could not get a GPS fix", "NO_FIX");
                        return;
                    }
                    call.resolve(toJs(loc));
                })
                .addOnFailureListener(e -> {
                    if (done[0]) return;
                    done[0] = true;
                    call.reject(e.getMessage(), "NO_FIX");
                });
        } catch (SecurityException se) {
            done[0] = true;
            call.reject("Location permission denied", "PERMISSION_DENIED");
        }
    }

    @SuppressWarnings("deprecation")
    private JSObject toJs(Location loc) {
        JSObject r = new JSObject();
        r.put("lat", loc.getLatitude());
        r.put("lng", loc.getLongitude());
        r.put("acc", loc.hasAccuracy() ? loc.getAccuracy() : null);
        boolean mock = Build.VERSION.SDK_INT >= 31 ? loc.isMock() : loc.isFromMockProvider();
        r.put("mock", mock);
        r.put("time", loc.getTime());
        return r;
    }

    @PluginMethod
    public void requestCamera(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            JSObject r = new JSObject();
            r.put("granted", true);
            call.resolve(r);
        } else {
            requestPermissionForAlias("camera", call, "cameraPermsCallback");
        }
    }

    @PermissionCallback
    private void cameraPermsCallback(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", getPermissionState("camera") == PermissionState.GRANTED);
        call.resolve(r);
    }

    // ------------------------------------------------------------------ biometrics
    @PluginMethod
    public void biometricAvailable(PluginCall call) {
        int res = BiometricManager.from(getContext()).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK);
        JSObject r = new JSObject();
        r.put("available", res == BiometricManager.BIOMETRIC_SUCCESS);
        r.put("reason", res);
        call.resolve(r);
    }

    @PluginMethod
    public void biometricAuth(PluginCall call) {
        final String title = call.getString("title", "Unlock");
        final String subtitle = call.getString("subtitle", "");
        final String cancel = call.getString("cancel", "Use PIN");
        final boolean[] done = { false };
        getActivity().runOnUiThread(() -> {
            try {
                Executor ex = ContextCompat.getMainExecutor(getContext());
                if (Build.VERSION.SDK_INT >= 28) {
                    // Android's own fingerprint dialog (no fragments, works from any screen)
                    android.hardware.biometrics.BiometricPrompt.Builder b = new android.hardware.biometrics.BiometricPrompt.Builder(getContext())
                        .setTitle(title)
                        .setNegativeButton(cancel, ex, (d, w) -> bioResult(call, done, false, 13, "cancel"));
                    if (!subtitle.isEmpty()) b.setSubtitle(subtitle);
                    if (Build.VERSION.SDK_INT >= 30) b.setAllowedAuthenticators(android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_WEAK);
                    b.build().authenticate(new CancellationSignal(), ex, new android.hardware.biometrics.BiometricPrompt.AuthenticationCallback() {
                        @Override
                        public void onAuthenticationSucceeded(android.hardware.biometrics.BiometricPrompt.AuthenticationResult result) {
                            bioResult(call, done, true, 0, "");
                        }

                        @Override
                        public void onAuthenticationError(int code, CharSequence err) {
                            bioResult(call, done, false, code, err == null ? "" : err.toString());
                        }
                    });
                } else {
                    BiometricPrompt prompt = new BiometricPrompt((FragmentActivity) getActivity(), ex, new BiometricPrompt.AuthenticationCallback() {
                        @Override
                        public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                            bioResult(call, done, true, 0, "");
                        }

                        @Override
                        public void onAuthenticationError(int code, CharSequence err) {
                            bioResult(call, done, false, code, err == null ? "" : err.toString());
                        }
                    });
                    BiometricPrompt.PromptInfo.Builder b = new BiometricPrompt.PromptInfo.Builder()
                        .setTitle(title)
                        .setNegativeButtonText(cancel)
                        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_WEAK);
                    if (!subtitle.isEmpty()) b.setSubtitle(subtitle);
                    prompt.authenticate(b.build());
                }
            } catch (Exception e) {
                bioResult(call, done, false, -1, String.valueOf(e.getMessage()));
            }
        });
    }

    private void bioResult(PluginCall call, boolean[] done, boolean ok, int code, String error) {
        if (done[0]) return;
        done[0] = true;
        JSObject r = new JSObject();
        r.put("ok", ok);
        r.put("code", code);
        r.put("error", error);
        call.resolve(r);
    }

    // ------------------------------------------------------------------ app
    @PluginMethod
    public void minimize(PluginCall call) {
        getActivity().runOnUiThread(() -> getActivity().moveTaskToBack(true));
        call.resolve();
    }

    // ------------------------------------------------------------------ files in the phone's Downloads folder
    // Android 10+: Downloads/<folder>. Older phones: the app's own Downloads folder.
    @PluginMethod
    public void saveDownload(PluginCall call) {
        String folder = call.getString("folder", "Afford").replaceAll("[^A-Za-z0-9 _-]", "_");
        String filename = call.getString("filename", "file.txt").replaceAll("[^A-Za-z0-9._-]", "_");
        String mime = call.getString("mime", "application/json");
        String text = call.getString("text", "");
        try {
            String where;
            if (Build.VERSION.SDK_INT >= 29) {
                ContentResolver cr = getContext().getContentResolver();
                String rel = Environment.DIRECTORY_DOWNLOADS + "/" + folder + "/";
                // replace a file with the same name made by this app
                try {
                    cr.delete(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                        MediaStore.MediaColumns.RELATIVE_PATH + "=? AND " + MediaStore.MediaColumns.DISPLAY_NAME + "=?", new String[] { rel, filename });
                } catch (Exception ignored) {
                    // a file left by an older install: Android adds (1) to the new name
                }
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, rel);
                v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) throw new Exception("cannot create file");
                try (OutputStream out = cr.openOutputStream(uri)) {
                    if (out == null) throw new Exception("cannot write file");
                    out.write(text.getBytes(StandardCharsets.UTF_8));
                }
                v.clear();
                v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                cr.update(uri, v, null, null);
                where = "Download/" + folder + "/" + filename;
            } else {
                File dir = new File(getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), folder);
                if (!dir.exists() && !dir.mkdirs()) throw new Exception("cannot create folder");
                File f = new File(dir, filename);
                try (FileOutputStream out = new FileOutputStream(f)) {
                    out.write(text.getBytes(StandardCharsets.UTF_8));
                }
                where = f.getAbsolutePath();
            }
            JSObject r = new JSObject();
            r.put("path", where);
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Could not save the file: " + e.getMessage());
        }
    }

    /** Deletes files this app saved in Downloads/<folder> that are older than keepDays. */
    @PluginMethod
    public void pruneDownloads(PluginCall call) {
        String folder = call.getString("folder", "Afford").replaceAll("[^A-Za-z0-9 _-]", "_");
        int keepDays = call.getInt("keepDays", 7);
        long cutoffMs = System.currentTimeMillis() - keepDays * 24L * 3600 * 1000;
        int removed = 0;
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentResolver cr = getContext().getContentResolver();
                String rel = Environment.DIRECTORY_DOWNLOADS + "/" + folder + "/";
                removed = cr.delete(MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    MediaStore.MediaColumns.RELATIVE_PATH + "=? AND " + MediaStore.MediaColumns.DATE_ADDED + "<?",
                    new String[] { rel, String.valueOf(cutoffMs / 1000) });
            } else {
                File dir = new File(getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), folder);
                File[] files = dir.listFiles();
                if (files != null) for (File f : files) if (f.lastModified() < cutoffMs && f.delete()) removed++;
            }
        } catch (Exception ignored) {
        }
        JSObject r = new JSObject();
        r.put("removed", removed);
        call.resolve(r);
    }

    // ------------------------------------------------------------------ encrypted storage (Android Keystore AES-GCM)
    private SecretKey secretKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (!ks.containsAlias(KEY_ALIAS)) {
            KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
            return kg.generateKey();
        }
        return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void secureSet(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || value == null) {
            call.reject("key and value are required");
            return;
        }
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, secretKey());
            byte[] ct = c.doFinal(value.getBytes(StandardCharsets.UTF_8));
            String stored = Base64.encodeToString(c.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP);
            prefs().edit().putString(key, stored).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not save securely: " + e.getMessage());
        }
    }

    @PluginMethod
    public void secureGet(PluginCall call) {
        String key = call.getString("key");
        JSObject r = new JSObject();
        String stored = key == null ? null : prefs().getString(key, null);
        if (stored == null) {
            r.put("value", null);
            call.resolve(r);
            return;
        }
        try {
            String[] parts = stored.split(":");
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            byte[] pt = c.doFinal(Base64.decode(parts[1], Base64.NO_WRAP));
            r.put("value", new String(pt, StandardCharsets.UTF_8));
        } catch (Exception e) {
            prefs().edit().remove(key).apply();
            r.put("value", null);
        }
        call.resolve(r);
    }

    @PluginMethod
    public void secureRemove(PluginCall call) {
        String key = call.getString("key");
        if (key != null) prefs().edit().remove(key).apply();
        call.resolve();
    }

    // ------------------------------------------------------------------ share / print / open
    @PluginMethod
    public void shareFile(PluginCall call) {
        String filename = call.getString("filename", "file.pdf").replaceAll("[^A-Za-z0-9._-]", "_");
        String mime = call.getString("mime", "application/pdf");
        String base64 = call.getString("base64");
        String text = call.getString("text");
        try {
            File dir = new File(getContext().getCacheDir(), "share");
            if (!dir.exists() && !dir.mkdirs()) throw new Exception("cannot create folder");
            File f = new File(dir, filename);
            try (FileOutputStream out = new FileOutputStream(f)) {
                if (text != null) out.write(text.getBytes(StandardCharsets.UTF_8));
                else if (base64 != null) out.write(Base64.decode(base64, Base64.DEFAULT));
            }
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", f);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mime);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(Intent.createChooser(send, call.getString("title", "Share")));
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not share: " + e.getMessage());
        }
    }

    @PluginMethod
    public void printHtml(PluginCall call) {
        final String html = call.getString("html", "");
        final String job = call.getString("jobName", "Afford");
        getActivity().runOnUiThread(() -> {
            WebView wv = new WebView(getActivity());
            wv.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String url) {
                    PrintManager pm = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                    PrintAttributes attrs = new PrintAttributes.Builder().setMediaSize(PrintAttributes.MediaSize.ISO_A4).build();
                    pm.print(job, view.createPrintDocumentAdapter(job), attrs);
                    call.resolve();
                }
            });
            printWebView = wv; // keep a reference until printing is done
            wv.loadDataWithBaseURL("https://localhost/", html, "text/html", "UTF-8", null);
        });
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(call.getString("url")));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open link");
        }
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getContext().getPackageName(), null));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    @PluginMethod
    public void keepAwake(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", true));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }
}

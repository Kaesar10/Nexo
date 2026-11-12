package com.nexo.movil;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Servicio en primer plano que mantiene el "push" de Nexo.
 *
 * No depende del WebView ni del SSE: hace long-poll contra `/api/push` con el
 * token del dispositivo y publica una notificación nativa cuando el puente
 * avisa de que terminó una tarea larga. Así funciona con la app cerrada, sin
 * FCM ni cuenta de Google.
 */
public class NexoPushService extends Service {

    public static final String PREFS = "nexo_push";
    public static final String EXTRA_CHAT_ID = "nexo_chat_id";
    public static volatile boolean running = false;

    private static final String TAG = "NexoPush";
    private static final String CHANNEL_SERVICE = "nexo_service";
    private static final String CHANNEL_TASKS = "nexo_tasks";
    private static final int SERVICE_NOTIFICATION_ID = 1001;

    private Thread worker;
    private volatile boolean stopped = false;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (running) {
            return START_STICKY;
        }
        startForeground(SERVICE_NOTIFICATION_ID, buildServiceNotification());
        running = true;
        stopped = false;
        worker = new Thread(this::loop, "nexo-push");
        worker.setDaemon(true);
        worker.start();
        Log.i(TAG, "servicio iniciado");
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopped = true;
        running = false;
        if (worker != null) worker.interrupt();
        Log.i(TAG, "servicio detenido");
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void loop() {
        while (!stopped) {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            String serverUrl = prefs.getString("serverUrl", "");
            String token = prefs.getString("token", "");
            if (serverUrl.isEmpty() || token.isEmpty()) {
                sleep(5000);
                continue;
            }
            int code = poll(serverUrl, token);
            if (code == 401) {
                // Token revocado: no tiene sentido seguir intentándolo.
                Log.i(TAG, "token revocado, parando servicio");
                stopSelf();
                return;
            }
            if (code != 200) sleep(8000);
        }
    }

    private int poll(String serverUrl, String token) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(serverUrl + "/api/push?wait=1");
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(45000);
            int code = connection.getResponseCode();
            if (code == 200) {
                StringBuilder body = new StringBuilder();
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) body.append(line);
                }
                JSONObject payload = new JSONObject(body.toString());
                JSONArray notifications = payload.optJSONArray("notifications");
                if (notifications != null) {
                    for (int index = 0; index < notifications.length(); index += 1) {
                        postTaskNotification(notifications.getJSONObject(index));
                    }
                }
            }
            return code;
        } catch (Exception error) {
            Log.w(TAG, "poll falló: " + error.getMessage());
            return -1;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void postTaskNotification(JSONObject item) {
        // Si el usuario está mirando la app, el aviso sobra (y duplicaría).
        if (MainActivity.visible) {
            Log.i(TAG, "app en primer plano: no se notifica");
            return;
        }
        String title = item.optString("title", "Nexo");
        String body = item.optString("body", "Tarea terminada");
        String chatId = item.optString("chatId", "");

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (!chatId.isEmpty()) open.putExtra(EXTRA_CHAT_ID, chatId);
        PendingIntent pending = PendingIntent.getActivity(
                this,
                chatId.hashCode(),
                open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_TASKS)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(pending);

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(Math.abs(chatId.hashCode()) + 2000, builder.build());
        }
    }

    private Notification buildServiceNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pending = PendingIntent.getActivity(
                this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CHANNEL_SERVICE)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("Nexo conectado")
                .setContentText("Recibiendo avisos de tu PC aunque cierres la app")
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .setSilent(true)
                .setContentIntent(pending)
                .build();
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel service = new NotificationChannel(
                CHANNEL_SERVICE, "Nexo conectado", NotificationManager.IMPORTANCE_LOW);
        service.setDescription("Mantiene el aviso de tareas aunque cierres Nexo");
        service.setShowBadge(false);
        manager.createNotificationChannel(service);

        NotificationChannel tasks = new NotificationChannel(
                CHANNEL_TASKS, "Tareas terminadas", NotificationManager.IMPORTANCE_HIGH);
        tasks.setDescription("Avisos cuando el agente termina una tarea larga");
        manager.createNotificationChannel(tasks);
    }

    private void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }
}

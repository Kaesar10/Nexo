package com.nexo.movil;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

/** Rearranca el servicio de avisos tras reiniciar el móvil, si ya estaba emparejado. */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        SharedPreferences prefs = context.getSharedPreferences(NexoPushService.PREFS, Context.MODE_PRIVATE);
        String token = prefs.getString("token", "");
        String serverUrl = prefs.getString("serverUrl", "");
        if (token.isEmpty() || serverUrl.isEmpty()) return;

        Intent service = new Intent(context, NexoPushService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(service);
        } else {
            context.startService(service);
        }
    }
}

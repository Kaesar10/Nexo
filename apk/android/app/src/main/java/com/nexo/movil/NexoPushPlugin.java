package com.nexo.movil;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Puente JS ⇄ servicio en primer plano.
 *
 * La app llama `start({ serverUrl, token })` al emparejar y en cada arranque;
 * el servicio guarda las credenciales y se queda escuchando avisos aunque la
 * interfaz esté cerrada.
 */
@CapacitorPlugin(name = "NexoPush")
public class NexoPushPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        String serverUrl = call.getString("serverUrl", "");
        String token = call.getString("token", "");
        if (serverUrl == null || serverUrl.trim().isEmpty() || token == null || token.trim().isEmpty()) {
            call.reject("Faltan serverUrl o token");
            return;
        }
        SharedPreferences prefs = getContext().getSharedPreferences(NexoPushService.PREFS, Context.MODE_PRIVATE);
        prefs.edit()
                .putString("serverUrl", serverUrl.trim().replaceAll("/+$", ""))
                .putString("token", token.trim())
                .apply();

        Intent intent = new Intent(getContext(), NexoPushService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        JSObject result = new JSObject();
        result.put("running", true);
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), NexoPushService.class));
        JSObject result = new JSObject();
        result.put("running", false);
        call.resolve(result);
    }

    @PluginMethod
    public void clear(PluginCall call) {
        getContext().stopService(new Intent(getContext(), NexoPushService.class));
        getContext()
                .getSharedPreferences(NexoPushService.PREFS, Context.MODE_PRIVATE)
                .edit()
                .clear()
                .apply();
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(NexoPushService.PREFS, Context.MODE_PRIVATE);
        JSObject result = new JSObject();
        result.put("running", NexoPushService.running);
        result.put("configured", !prefs.getString("token", "").isEmpty());
        call.resolve(result);
    }
}

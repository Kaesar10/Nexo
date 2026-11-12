package com.nexo.movil;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

/**
 * Nexo registra el plugin de push propio y avisa a la app de si pasa a segundo
 * plano o vuelve, con eventos JS ("nexo:background" / "nexo:foreground").
 */
public class MainActivity extends BridgeActivity {

    /** Lo consulta el servicio de push para no avisar si estás mirando la app. */
    public static volatile boolean visible = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NexoPushPlugin.class);
        super.onCreate(savedInstanceState);
    }

    private void dispatch(String event) {
        try {
            WebView webView = getBridge().getWebView();
            if (webView != null) {
                String js = "window.dispatchEvent(new Event('" + event + "'))";
                webView.post(() -> webView.evaluateJavascript(js, null));
            }
        } catch (Exception ignored) {
            // el bridge aún no está listo
        }
    }

    @Override
    public void onPause() {
        visible = false;
        dispatch("nexo:background");
        super.onPause();
    }

    @Override
    public void onResume() {
        super.onResume();
        visible = true;
        dispatch("nexo:foreground");
    }
}

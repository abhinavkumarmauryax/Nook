package com.nook.client;

import android.os.Bundle;
import android.view.View;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

public class MainActivity extends AppCompatActivity {
    private WebView webView;
    private EditText hostInput;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        hostInput = findViewById(R.id.hostInput);
        Button connect = findViewById(R.id.connectBtn);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        webView.setWebViewClient(new WebViewClient());

        connect.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String host = hostInput.getText().toString().trim();
                if (host.isEmpty()) {
                    Toast.makeText(MainActivity.this, "Enter the host address", Toast.LENGTH_SHORT).show();
                    return;
                }
                if (!host.startsWith("http://") && !host.startsWith("https://")) host = "http://" + host;
                if (host.endsWith("/")) host = host.substring(0, host.length() - 1);
                webView.loadUrl(host + "/join");
            }
        });
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }
}

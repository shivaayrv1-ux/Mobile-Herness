package com.vikki.mhcloud;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SshBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}

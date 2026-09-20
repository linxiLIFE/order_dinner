package com.orderdinner.pos;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PrinterHostPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

package jp.ksg.worldphotoplanner;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Web画面からKSGアプリ固有の権限設定を開くため、Bridge生成前に登録する。
        registerPlugin(KsgNativeSettingsPlugin.class);
        registerPlugin(KsgCameraInfoPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

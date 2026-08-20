package jp.astrosight.app;

import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AstroSightNativeSettings")
public class AstroSightNativeSettingsPlugin extends Plugin {
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        // 権限拒否後は一般設定ではなく、このアプリ自身の権限画面へ誘導する。
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void openLocationSettings(PluginCall call) {
        // 端末全体の位置情報サービスがOFFの場合だけ利用する設定画面。
        Intent intent = new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }
}

package jp.astrosight.app;

import android.content.Context;
import android.graphics.Rect;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.util.SizeF;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AstroSightCameraInfo")
public class AstroSightCameraInfoPlugin extends Plugin {
    @PluginMethod
    public void getRearCameras(PluginCall call) {
        JSArray cameras = new JSArray();
        try {
            CameraManager manager = (CameraManager) getContext().getSystemService(Context.CAMERA_SERVICE);
            for (String cameraId : manager.getCameraIdList()) {
                CameraCharacteristics characteristics = manager.getCameraCharacteristics(cameraId);
                Integer facing = characteristics.get(CameraCharacteristics.LENS_FACING);
                if (facing == null || facing != CameraCharacteristics.LENS_FACING_BACK) continue;

                JSObject camera = new JSObject();
                camera.put("cameraId", cameraId);

                JSArray focalLengths = new JSArray();
                float[] focalLengthValues = characteristics.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
                if (focalLengthValues != null) {
                    for (float value : focalLengthValues) focalLengths.put(value);
                }
                camera.put("focalLengthsMm", focalLengths);

                SizeF physicalSize = characteristics.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE);
                camera.put("sensorWidthMm", physicalSize != null ? physicalSize.getWidth() : JSObject.NULL);
                camera.put("sensorHeightMm", physicalSize != null ? physicalSize.getHeight() : JSObject.NULL);

                Rect activeArray = characteristics.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
                camera.put("activeArrayWidthPx", activeArray != null ? activeArray.width() : JSObject.NULL);
                camera.put("activeArrayHeightPx", activeArray != null ? activeArray.height() : JSObject.NULL);
                cameras.put(camera);
            }
            JSObject result = new JSObject();
            result.put("cameras", cameras);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Camera2 metadata could not be read", error);
        }
    }
}

import Flutter
import MobileStackRaw
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  private var resultFileChannel: FlutterMethodChannel?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions:
      [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    // A direct reference keeps the static ABI object file in the final image.
    _ = mobile_stack_raw_abi_version()
    _ = mobile_stack_raw_capabilities()
    _ = mobile_stack_demosaic_api_version()
    return super.application(
      application,
      didFinishLaunchingWithOptions: launchOptions
    )
  }

  func didInitializeImplicitFlutterEngine(
    _ engineBridge: FlutterImplicitEngineBridge
  ) {
    GeneratedPluginRegistrant.register(
      with: engineBridge.pluginRegistry
    )
    guard let registrar = engineBridge.pluginRegistry.registrar(
      forPlugin: "MobileStackResultFiles"
    ) else {
      return
    }
    let channel = FlutterMethodChannel(
      name: "com.mobilestack.app/result_files",
      binaryMessenger: registrar.messenger()
    )
    channel.setMethodCallHandler { [weak self] call, result in
      guard call.method == "saveResult" else {
        result(FlutterMethodNotImplemented)
        return
      }
      guard let self else {
        result(FlutterError(
          code: "unavailable",
          message: "保存機能を初期化できませんでした。",
          details: nil
        ))
        return
      }
      self.saveResult(call: call, result: result)
    }
    resultFileChannel = channel
  }

  private func saveResult(
    call: FlutterMethodCall,
    result: @escaping FlutterResult
  ) {
    guard
      let arguments = call.arguments as? [String: Any],
      let sourcePath = arguments["sourcePath"] as? String,
      let requestedName = arguments["displayName"] as? String
    else {
      result(FlutterError(
        code: "invalid_arguments",
        message: "保存元またはファイル名がありません。",
        details: nil
      ))
      return
    }
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let fileManager = FileManager.default
        let source = URL(fileURLWithPath: sourcePath)
        guard fileManager.fileExists(atPath: source.path) else {
          throw CocoaError(.fileNoSuchFile)
        }
        let documents = try fileManager.url(
          for: .documentDirectory,
          in: .userDomainMask,
          appropriateFor: nil,
          create: true
        )
        let safeName = URL(fileURLWithPath: requestedName).lastPathComponent
        let allowedExtensions: Set<String> = ["bmp", "jpg", "jpeg", "tif", "tiff", "dng"]
        let requestedExtension = (safeName as NSString).pathExtension.lowercased()
        let sourceExtension = source.pathExtension.lowercased()
        let fileExtension: String
        if allowedExtensions.contains(requestedExtension) {
          fileExtension = requestedExtension
        } else if allowedExtensions.contains(sourceExtension) {
          fileExtension = sourceExtension
        } else {
          fileExtension = "bmp"
        }
        let requestedBase = (safeName as NSString).deletingPathExtension
        let safeBase = requestedBase.isEmpty ? "MobileStack_result" : requestedBase
        let normalizedName = "\(safeBase).\(fileExtension)"
        var destination = documents.appendingPathComponent(normalizedName)
        var suffix = 2
        while fileManager.fileExists(atPath: destination.path) {
          let base = (normalizedName as NSString).deletingPathExtension
          destination = documents.appendingPathComponent(
            "\(base)-\(suffix).\(fileExtension)"
          )
          suffix += 1
        }
        try fileManager.copyItem(at: source, to: destination)
        DispatchQueue.main.async {
          result("このiPhone内/Mobile Stack/\(destination.lastPathComponent)")
        }
      } catch {
        DispatchQueue.main.async {
          result(FlutterError(
            code: "save_failed",
            message: error.localizedDescription,
            details: nil
          ))
        }
      }
    }
  }
}

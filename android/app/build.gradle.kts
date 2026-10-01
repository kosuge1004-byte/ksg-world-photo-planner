import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("dev.flutter.flutter-gradle-plugin")
}

val mobileStackArm64Only =
    providers.gradleProperty("mobileStackArm64Only").orNull == "true"

// Release signing: previously always signingConfigs.getByName("debug"), so
// a release build was signed with the debug key that Android Studio
// generates per-machine. That is fine for a single throwaway local test
// APK, but not for something meant to be installed once and updated later
// (Android refuses to install an update whose signature does not match the
// already-installed app) — see
// https://developer.android.com/studio/publish/preparing. Real release
// credentials are never committed; this reads them from
// android/app/key.properties (gitignored) when present:
//
//   storeFile=/absolute/or/relative/path/to/release.keystore
//   storePassword=...
//   keyAlias=...
//   keyPassword=...
//
// Falls back to the debug key with a build-time warning (not a silent
// substitution) when that file is absent, so a fresh checkout still builds
// out of the box for local testing without every contributor needing a
// release keystore, while making it unmistakable in the build log that the
// resulting APK is not the continuously-distributable release artifact.
val releaseKeystoreProperties = Properties()
val releaseKeystorePropertiesFile = rootProject.file("app/key.properties")
val hasReleaseKeystore = releaseKeystorePropertiesFile.exists().also { exists ->
    if (exists) {
        releaseKeystorePropertiesFile.inputStream().use { releaseKeystoreProperties.load(it) }
    } else {
        logger.warn(
            "android/key.properties not found: release build type will be signed with the " +
                "DEBUG key. This is fine for local testing, but an APK signed this way cannot " +
                "be used to update an install signed with a real release key later. See the " +
                "comment above this in app/build.gradle.kts to set up real release signing.",
        )
    }
}

android {
    namespace = "com.mobilestack.app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        isCoreLibraryDesugaringEnabled = true
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "com.mobilestack.app"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName

        if (mobileStackArm64Only) {
            ndk {
                abiFilters += "arm64-v8a"
            }
        }

        externalNativeBuild {
            cmake {
                arguments += "-DANDROID_STL=c++_static"
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("CMakeLists.txt")
            version = "3.22.1"
        }
    }

    if (mobileStackArm64Only) {
        packaging {
            jniLibs {
                excludes += setOf(
                    "lib/armeabi-v7a/**",
                    "lib/x86_64/**",
                )
            }
        }
    }

    if (hasReleaseKeystore) {
        signingConfigs {
            create("release") {
                storeFile = file(releaseKeystoreProperties.getProperty("storeFile"))
                storePassword = releaseKeystoreProperties.getProperty("storePassword")
                keyAlias = releaseKeystoreProperties.getProperty("keyAlias")
                keyPassword = releaseKeystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = if (hasReleaseKeystore) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
}

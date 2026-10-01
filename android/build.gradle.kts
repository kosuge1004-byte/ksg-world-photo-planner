import com.android.build.api.dsl.LibraryExtension

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

val sharedBuildDirectory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(sharedBuildDirectory)

subprojects {
    val projectBuildDirectory = sharedBuildDirectory.dir(project.name)
    project.layout.buildDirectory.value(projectBuildDirectory)
}
subprojects {
    project.evaluationDependsOn(":app")
}

// Keep application lint strict while suppressing only known dependency-owned
// findings. These plugin versions handle the relevant compatibility paths at
// runtime, but newer AGP/Kotlin lint versions flag their library source before
// the app module's release lint can complete.
subprojects {
    val dependencyLintSuppressions =
        when (name) {
            "flutter_local_notifications" -> setOf("MissingPermission")
            "shared_preferences_android" -> setOf("MemberExtensionConflict")
            "workmanager_android" -> setOf("NewApi", "RestrictedApi")
            else -> emptySet()
        }
    if (dependencyLintSuppressions.isNotEmpty()) {
        plugins.withId("com.android.library") {
            extensions.configure<LibraryExtension> {
                lint {
                    disable += dependencyLintSuppressions
                }
            }
        }
    }
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}

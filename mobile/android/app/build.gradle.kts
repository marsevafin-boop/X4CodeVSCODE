plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Ключ подписи: PKCS12 из секрета GitHub (release.p12 в корне проекта).
// Без него — debug-подпись (установится, но обновление поверх потребует переустановки).
val keystore = rootProject.file("release.p12")

android {
    namespace = "ru.marse.agenthub"
    compileSdk = 35

    defaultConfig {
        applicationId = "ru.marse.agenthub"
        minSdk = 26
        targetSdk = 35
        versionCode = (System.getenv("APP_VERSION_CODE") ?: "1").toInt()
        versionName = (System.getenv("APP_VERSION_NAME") ?: "dev").removePrefix("v")
    }

    signingConfigs {
        create("release") {
            if (keystore.exists()) {
                storeFile = keystore
                storeType = "PKCS12"
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = "agenthub"
                keyPassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig =
                if (keystore.exists()) signingConfigs.getByName("release")
                else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
}

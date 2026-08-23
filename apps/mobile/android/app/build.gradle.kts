plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val releaseStoreFile = providers.environmentVariable("DSH_ANDROID_KEYSTORE_FILE")
val releaseStorePassword = providers.environmentVariable("DSH_ANDROID_KEYSTORE_PASSWORD")
val releaseKeyAlias = providers.environmentVariable("DSH_ANDROID_KEY_ALIAS")
val releaseKeyPassword = providers.environmentVariable("DSH_ANDROID_KEY_PASSWORD")
val releaseSigningConfigured = listOf(
    releaseStoreFile,
    releaseStorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
).all { it.isPresent }

android {
    namespace = "io.github.sayach.dshmobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.sayach.dshmobile"
        minSdk = 29
        targetSdk = 36
        versionCode = 41
        versionName = "0.1.4"
    }

    signingConfigs {
        create("release") {
            if (releaseSigningConfigured) {
                storeFile = file(releaseStoreFile.get())
                storePassword = releaseStorePassword.get()
                keyAlias = releaseKeyAlias.get()
                keyPassword = releaseKeyPassword.get()
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            if (releaseSigningConfigured) signingConfig = signingConfigs.getByName("release")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }

    lint {
        checkTestSources = false
    }

    sourceSets.getByName("test").resources.srcDir("../../contract")
}

dependencies {
    implementation("com.google.zxing:core:3.5.4")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20260814")
}

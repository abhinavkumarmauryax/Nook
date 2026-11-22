# Nook for Android

This is an Android **client** for a Nook server. The watch/chat server itself
runs on a host computer — the phone connects to it over Wi-Fi, ZeroTier or a
tunnel. It is a small WebView app: enter the host address (e.g.
`192.168.1.10:3001`) and it opens the Nook join screen.

## Why no APK is included here

Building an installable APK requires the Android SDK, a JDK and Gradle, none of
which are available in the environment used to create this repository. The
source below is a complete, minimal Android Studio project — open it and build
an APK locally.

## Build it

1. Install Android Studio with the Android 14 (API 34) SDK.
2. Open this `android/` folder as a project.
3. Let Gradle sync, then **Build → Build Bundle(s) / APK(s) → Build APK(s)**.
4. Install the generated `app-debug.apk` on your phone, or publish the signed
   bundle to a store.

If Gradle reports that the wrapper is missing, let Android Studio generate it
(**File → Project Structure → Gradle Wrapper**) or build from the Build menu.

## Using it

- Run Nook on the host and note the Session URL (for example
  `http://192.168.1.10:3001`).
- Enter `192.168.1.10:3001` in the app and tap **Connect**.
- Pick a username and join like any other participant.

The app requests only `INTERNET` permission and allows clear-text HTTP so LAN
addresses work. Use a tunnel with HTTPS when connecting over the public internet.

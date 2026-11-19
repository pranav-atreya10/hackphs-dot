import SwiftUI

@main
struct SkySentryCamApp: App {
    init() {
        CameraCredentials.migrate()
        if UserDefaults.standard.string(forKey: SettingKey.cameraId) == "iphone-1" {
            UserDefaults.standard.removeObject(forKey: SettingKey.cameraId)
        }
        UserDefaults.standard.register(defaults: SettingDefaults.all)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

struct RootView: View {
    @State private var showCamera = false

    var body: some View {
        NavigationStack {
            SetupView(onOpenCamera: { showCamera = true })
                .toolbar(.hidden, for: .navigationBar)
        }
        .tint(Theme.accent)
        .preferredColorScheme(.light)
        .fullScreenCover(isPresented: $showCamera) {
            CameraScreen()
        }
        .onAppear {
            // Testing hook: `xcrun simctl launch … -autoOpenCamera YES` opens the camera screen at launch.
            if UserDefaults.standard.bool(forKey: "autoOpenCamera") { showCamera = true }
        }
    }
}

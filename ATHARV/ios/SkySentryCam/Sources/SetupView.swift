import SwiftUI

/// Settings, saved on the device with @AppStorage.
struct SetupView: View {
    /// Shown as the big button at the bottom; nil when Setup is opened from the camera screen.
    var onOpenCamera: (() -> Void)?

    @AppStorage(SettingKey.serverURL) private var serverURL = SettingDefaults.serverURL
    @AppStorage(SettingKey.apiKey) private var apiKey = ""
    @AppStorage(SettingKey.airport) private var airport = ""
    @AppStorage(SettingKey.cameraId) private var cameraId = SettingDefaults.cameraId
    @AppStorage(SettingKey.heading) private var heading = SettingDefaults.heading
    @AppStorage(SettingKey.hfov) private var hfov = SettingDefaults.hfov
    @AppStorage(SettingKey.lat) private var lat = SettingDefaults.lat
    @AppStorage(SettingKey.lon) private var lon = SettingDefaults.lon
    @AppStorage(SettingKey.corridorSide) private var corridorSide = SettingDefaults.corridorSide
    @AppStorage(SettingKey.corridorWidth) private var corridorWidth = SettingDefaults.corridorWidth
    @AppStorage(SettingKey.sourcePref) private var sourcePref = SourcePreference.auto.rawValue

    @StateObject private var location = LocationHelper()
    @FocusState private var focused: Bool

    private let cameraAvailable = CameraSource.isAvailable

    var body: some View {
        Form {
            Section {
                header
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 8, leading: 4, bottom: 4, trailing: 4))
            }

            Section {
                field("Server URL", systemImage: "network") {
                    TextField("https://…ondigitalocean.app", text: $serverURL)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                }
                field("Camera key", systemImage: "key") {
                    SecureField("from the team", text: $apiKey)
                        .textContentType(.password)
                }
                field("Airport", systemImage: "airplane") {
                    TextField("optional, e.g. KPCT", text: $airport)
                        .textInputAutocapitalization(.characters)
                }
                field("Camera ID", systemImage: "camera") {
                    TextField("iphone-1", text: $cameraId)
                }
            } header: {
                sectionHeader("Server")
            } footer: {
                Text("On a real iPhone, localhost is the phone itself. Use your Mac's address on the same Wi-Fi (http://192.168.x.x:8095) or the https:// DigitalOcean URL.")
            }

            Section {
                numberRow("Facing", value: $heading, unit: "°", hint: compassPoint(heading))
                numberRow("Lens width", value: $hfov, unit: "°", hint: "field of view")
                numberRow("Latitude", value: $lat, unit: "", hint: nil, decimals: 6)
                numberRow("Longitude", value: $lon, unit: "", hint: nil, decimals: 6)
                Button {
                    focused = false
                    location.request()
                } label: {
                    HStack {
                        Label("Use my location & compass", systemImage: "location.north.circle")
                        Spacer()
                        if location.busy { ProgressView() }
                    }
                }
                .disabled(location.busy)
                .foregroundStyle(Theme.accent)
                .listRowBackground(Theme.card)
                if let msg = location.message {
                    Text(msg).font(.footnote).foregroundStyle(Theme.muted)
                        .listRowBackground(Theme.card)
                }
            } header: {
                sectionHeader("Where the camera points")
            } footer: {
                Text("Mount the phone, point the back camera at the runway approach, then tap the button to fill these in.")
            }

            Section {
                Picker("Runway side of the picture", selection: $corridorSide) {
                    Text("Left").tag("left")
                    Text("Right").tag("right")
                }
                .pickerStyle(.segmented)
                .listRowBackground(Theme.card)
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text("Corridor width")
                        Spacer()
                        Text("\(Int((corridorWidth * 100).rounded())) % of the frame")
                            .foregroundStyle(Theme.muted)
                            .monospacedDigit()
                    }
                    Slider(value: $corridorWidth, in: 0.1...0.6, step: 0.05)
                }
                .listRowBackground(Theme.card)
            } header: {
                sectionHeader("Runway corridor")
            } footer: {
                Text("The approach area the bot watches. Anything flying into it raises the risk level.")
            }

            Section {
                Picker("Video", selection: $sourcePref) {
                    ForEach(SourcePreference.allCases) { Text($0.label).tag($0.rawValue) }
                }
                .listRowBackground(Theme.card)
            } header: {
                sectionHeader("Video source")
            } footer: {
                Text(cameraAvailable
                     ? "Automatic uses the rear camera. Demo sky streams a synthetic flock for testing."
                     : "No camera here (simulator), so the app streams the demo sky: a synthetic flock of birds.")
            }

            if let onOpenCamera {
                Section {
                    Button {
                        focused = false
                        onOpenCamera()
                    } label: {
                        HStack {
                            Spacer()
                            Label("Open camera", systemImage: "video.fill")
                                .font(.headline)
                            Spacer()
                        }
                        .padding(.vertical, 6)
                    }
                    .foregroundStyle(.white)
                    .listRowBackground(Theme.accent)
                }
            }
        }
        .focused($focused)
        .scrollContentBackground(.hidden)
        .background(Theme.paper.ignoresSafeArea())
        .foregroundStyle(Theme.ink)
        .tint(Theme.accent)
        .autocorrectionDisabled()
        .textInputAutocapitalization(.never)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { focused = false }
            }
        }
        .onAppear {
            location.onLocation = { la, lo in lat = la; lon = lo }
            location.onHeading = { h in heading = h }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("SkySentry Camera")
                .font(Theme.serif(.largeTitle, weight: .bold))
                .foregroundStyle(Theme.ink)
            Text("Turns this iPhone into a runway camera. It streams live video to the SkySentry server, whose bot looks for birds and drones and sends the boxes back.")
                .font(.subheadline)
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func sectionHeader(_ text: String) -> some View {
        Text(text)
            .font(Theme.serif(.headline))
            .foregroundStyle(Theme.accent)
            .textCase(nil)
    }

    private func field<Content: View>(_ title: String, systemImage: String, @ViewBuilder content: () -> Content) -> some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .foregroundStyle(Theme.accent)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.caption).foregroundStyle(Theme.muted)
                content()
            }
        }
        .listRowBackground(Theme.card)
    }

    private func numberRow(_ title: String, value: Binding<Double>, unit: String, hint: String?, decimals: Int = 1) -> some View {
        HStack {
            Text(title)
            if let hint {
                Text(hint).font(.caption).foregroundStyle(Theme.muted)
            }
            Spacer()
            TextField(title, value: value, format: .number.precision(.fractionLength(0...decimals)))
                .keyboardType(.numbersAndPunctuation)
                .multilineTextAlignment(.trailing)
                .monospacedDigit()
                .frame(maxWidth: 140)
            if !unit.isEmpty { Text(unit).foregroundStyle(Theme.muted) }
        }
        .listRowBackground(Theme.card)
    }
}

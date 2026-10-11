import CoreLocation
import Foundation

/// One-shot "Use my location & compass": a single location fix plus one good compass reading.
final class LocationHelper: NSObject, ObservableObject, CLLocationManagerDelegate {
    @Published private(set) var busy = false
    @Published private(set) var message: String?

    var onLocation: ((Double, Double) -> Void)?
    var onHeading: ((Double) -> Void)?

    private let manager = CLLocationManager()
    private var gotFix = false
    private var gotHeading = false
    private var timeout: DispatchWorkItem?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.headingFilter = 1
    }

    func request() {
        busy = true
        message = "Finding your location…"
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            finish("Location is off for SkySentry. Turn it on in Settings, or type the numbers in.")
        default:
            begin()
        }
    }

    private func begin() {
        gotFix = false
        gotHeading = !CLLocationManager.headingAvailable()
        manager.startUpdatingLocation()
        if !gotHeading { manager.startUpdatingHeading() }
        timeout?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.busy else { return }
            self.manager.stopUpdatingHeading()
            self.manager.stopUpdatingLocation()
            self.finish(self.gotFix ? "Location filled. No compass reading, so set the heading by hand."
                                    : "Couldn't get a location fix. Type the numbers in instead.")
        }
        timeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: work)
    }

    private func finishIfDone() {
        guard gotFix && gotHeading else { return }
        let compass = CLLocationManager.headingAvailable() ? "Location and compass heading filled." : "Location filled. This device has no compass, so set the heading by hand."
        finish(compass)
    }

    private func finish(_ text: String) {
        timeout?.cancel()
        busy = false
        message = text
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard busy else { return }
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways: begin()
        case .denied, .restricted: finish("Location is off for SkySentry. Turn it on in Settings, or type the numbers in.")
        default: break
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard busy, let loc = locations.last else { return }
        guard loc.horizontalAccuracy >= 0 else { return }
        manager.stopUpdatingLocation()
        onLocation?((loc.coordinate.latitude * 1e6).rounded() / 1e6, (loc.coordinate.longitude * 1e6).rounded() / 1e6)
        gotFix = true
        finishIfDone()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        guard busy, newHeading.headingAccuracy >= 0 else { return }
        let h = newHeading.trueHeading >= 0 ? newHeading.trueHeading : newHeading.magneticHeading
        onHeading?((h * 10).rounded() / 10)
        gotHeading = true
        manager.stopUpdatingHeading()
        finishIfDone()
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard busy else { return }
        if let e = error as? CLError, e.code == .locationUnknown { return }   // keeps trying until the timeout
        manager.stopUpdatingHeading()
        manager.stopUpdatingLocation()
        finish("Couldn't get a location fix (\(error.localizedDescription)). Type the numbers in instead.")
    }
}

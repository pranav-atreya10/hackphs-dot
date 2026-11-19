import Foundation

enum APIError: Error {
    case badURL
    case unauthorized
    case http(Int, String)
    case unreachable(String)
    case insecure
    case badReply
    case deviceIdentity

    /// Clear, user-facing text for the camera screen.
    func message(server: String) -> String {
        switch self {
        case .badURL:
            return "The server URL doesn't look right. Use something like https://your-app.ondigitalocean.app or http://192.168.1.20:8095."
        case .unauthorized:
            return "The server rejected the camera key (401). Check the camera key in Setup."
        case .http(let code, let body):
            return "The server answered \(code)\(body.isEmpty ? "" : ": \(body)"). Retrying…"
        case .unreachable(let detail):
            return "Can't reach the server at \(server). \(detail) Retrying…"
        case .insecure:
            return "iOS only allows plain http:// on the local network. Use the https:// address for the deployed server."
        case .badReply:
            return "The server sent a reply the app couldn't read. Is the URL pointing at the SkySentry server?"
        case .deviceIdentity:
            return "The camera device ID is unavailable in Keychain. Unlock the iPhone and try again."
        }
    }
}

/// Native live-camera configuration, frame uploads and stop.
final class SkyAPI {
    private let session: URLSession

    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 8
        config.timeoutIntervalForResource = 15
        config.waitsForConnectivity = false
        config.httpMaximumConnectionsPerHost = 2
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: config)
    }

    /// Normalizes what the user typed: trims, adds a scheme (http for local hosts, https otherwise), drops trailing slashes.
    static func baseURL(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        let lower = s.lowercased()
        if !lower.hasPrefix("http://") && !lower.hasPrefix("https://") {
            let host = lower.split(separator: "/").first.map(String.init) ?? lower
            let local = host.hasPrefix("localhost") || host.hasPrefix("127.") || host.hasPrefix("10.")
                || host.hasPrefix("192.168.") || host.hasPrefix("172.") || host.contains(".local")
            s = (local ? "http://" : "https://") + s
        }
        while s.hasSuffix("/") { s.removeLast() }
        guard let url = URL(string: s), let host = url.host, !host.isEmpty else { return nil }
        return url
    }

    private func request(_ path: String, _ s: StreamSettings, deviceID: String, streamID: String) -> URLRequest? {
        guard let base = Self.baseURL(s.serverURL) else { return nil }
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue(s.apiKey.trimmingCharacters(in: .whitespacesAndNewlines), forHTTPHeaderField: "x-api-key")
        let id = s.cameraId.trimmingCharacters(in: .whitespacesAndNewlines)
        req.setValue(id.isEmpty ? SettingDefaults.cameraId : id, forHTTPHeaderField: "x-camera-id")
        req.setValue(deviceID, forHTTPHeaderField: "x-camera-device")
        req.setValue(streamID, forHTTPHeaderField: "x-camera-session")
        req.setValue("live", forHTTPHeaderField: "x-camera-source")
        let airport = s.airport.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if !airport.isEmpty { req.setValue(airport, forHTTPHeaderField: "x-airport") }
        return req
    }

    @discardableResult
    func sendConfig(_ s: StreamSettings, streamID: String, completion: @escaping (Result<Void, APIError>) -> Void) -> URLSessionTask? {
        guard let deviceID = s.deviceId else { completion(.failure(.deviceIdentity)); return nil }
        guard var req = request("api/camera-config", s, deviceID: deviceID, streamID: streamID) else { completion(.failure(.badURL)); return nil }
        let body: [String: Any] = [
            "source": "live",
            "camera": ["lat": s.lat, "lon": s.lon, "heading_deg": s.heading, "hfov_deg": s.hfov],
        ]
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        let task = session.dataTask(with: req) { data, resp, err in
            completion(Self.check(data, resp, err).map { _ in () })
        }
        task.resume()
        return task
    }

    func sendStop(_ s: StreamSettings, streamID: String) {
        guard let deviceID = s.deviceId,
              let req = request("api/camera-stop", s, deviceID: deviceID, streamID: streamID) else { return }
        session.dataTask(with: req) { _, _, _ in }.resume()
    }

    @discardableResult
    func sendFrame(_ jpeg: Data, time: Double, settings s: StreamSettings, streamID: String,
                   completion: @escaping (Result<FrameReply, APIError>) -> Void) -> URLSessionTask? {
        guard let deviceID = s.deviceId else { completion(.failure(.deviceIdentity)); return nil }
        guard var req = request("api/camera-frame", s, deviceID: deviceID, streamID: streamID) else { completion(.failure(.badURL)); return nil }
        req.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        req.setValue(String(format: "%.3f", time), forHTTPHeaderField: "x-frame-time")
        let task = session.uploadTask(with: req, from: jpeg) { data, resp, err in
            switch Self.check(data, resp, err) {
            case .failure(let e): completion(.failure(e))
            case .success(let body):
                guard let reply = try? JSONDecoder().decode(FrameReply.self, from: body), reply.ok == true else {
                    return completion(.failure(.badReply))
                }
                completion(.success(reply))
            }
        }
        task.resume()
        return task
    }

    private static func check(_ data: Data?, _ resp: URLResponse?, _ err: Error?) -> Result<Data, APIError> {
        if let err = err as? URLError {
            switch err.code {
            case .appTransportSecurityRequiresSecureConnection, .secureConnectionFailed:
                return .failure(.insecure)
            case .timedOut:
                return .failure(.unreachable("The request timed out."))
            case .cannotFindHost, .dnsLookupFailed:
                return .failure(.unreachable("The host name wasn't found."))
            case .cannotConnectToHost:
                return .failure(.unreachable("Nothing is answering on that address and port."))
            case .notConnectedToInternet:
                return .failure(.unreachable("This phone is offline."))
            default:
                return .failure(.unreachable(err.localizedDescription))
            }
        }
        if let err { return .failure(.unreachable(err.localizedDescription)) }
        guard let http = resp as? HTTPURLResponse else { return .failure(.badReply) }
        let body = data ?? Data()
        if http.statusCode == 401 || http.statusCode == 403 { return .failure(.unauthorized) }
        guard (200..<300).contains(http.statusCode) else {
            var text = String(data: body.prefix(160), encoding: .utf8) ?? ""
            if let obj = try? JSONSerialization.jsonObject(with: body) as? [String: Any], let e = obj["error"] as? String { text = e }
            return .failure(.http(http.statusCode, text.trimmingCharacters(in: .whitespacesAndNewlines)))
        }
        return .success(body)
    }
}

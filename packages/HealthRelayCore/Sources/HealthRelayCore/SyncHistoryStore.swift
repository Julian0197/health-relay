import Foundation
import SQLite3

/// Indexed, device-local history. The operational journal remains authoritative.
/// A private lock serializes one connection, including queries from UI background tasks.
public final class SyncHistoryStore: @unchecked Sendable {
    public static let retention: TimeInterval = 20 * 86400
    public let file: URL
    private let lock = NSRecursiveLock()
    private var db: OpaquePointer?
    private let encoder: JSONEncoder = { let e = JSONEncoder(); e.dateEncodingStrategy = .millisecondsSince1970; return e }()
    private let decoder: JSONDecoder = { let d = JSONDecoder(); d.dateDecodingStrategy = .millisecondsSince1970; return d }()
    public init(file: URL) { self.file = file }
    deinit { if let db { sqlite3_close(db) } }

    private func open() throws {
        guard db == nil else { return }
        let directory = file.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        #if os(iOS) || os(watchOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: directory.path)
        #endif
        var excluded = URLResourceValues(); excluded.isExcludedFromBackup = true
        var directoryURL = directory; try directoryURL.setResourceValues(excluded)
        var connection: OpaquePointer?
        guard sqlite3_open_v2(file.path, &connection, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK, let connection else {
            if let connection { sqlite3_close(connection) }; throw ConfigurationError("同步历史数据库无法打开")
        }
        db = connection
        do {
            sqlite3_busy_timeout(connection, 2000)
            try execute("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;")
            try execute("CREATE TABLE IF NOT EXISTS history_entries(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,updated_at REAL NOT NULL,state TEXT NOT NULL,payload BLOB NOT NULL);")
            try execute("CREATE INDEX IF NOT EXISTS history_time ON history_entries(updated_at DESC,id DESC); CREATE INDEX IF NOT EXISTS history_task ON history_entries(task_id,updated_at DESC,id DESC);")
            try execute("CREATE TABLE IF NOT EXISTS history_events(id TEXT PRIMARY KEY,entry_id TEXT NOT NULL REFERENCES history_entries(id) ON DELETE CASCADE,at REAL NOT NULL,attempt_id TEXT,payload BLOB NOT NULL); CREATE INDEX IF NOT EXISTS history_event_entry ON history_events(entry_id,at,id);")
            #if os(iOS) || os(watchOS)
            for url in [file, URL(fileURLWithPath: file.path + "-wal"), URL(fileURLWithPath: file.path + "-shm")] where FileManager.default.fileExists(atPath: url.path) {
                try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
            }
            #endif
        } catch { sqlite3_close(connection); db = nil; throw error }
    }
    // Do not retain protected SQLite descriptors across device-lock or restore boundaries.
    private func closeConnection() {
        if let db { sqlite3_close(db); self.db = nil }
    }
    private func execute(_ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw ConfigurationError("同步历史数据库操作失败，原文件已保留") }
    }
    private enum Value { case text(String), number(Double), blob(Data), null }
    private func statement(_ sql: String, _ values: [Value] = []) throws -> OpaquePointer {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else { throw ConfigurationError("同步历史查询失败，原文件已保留") }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (offset, value) in values.enumerated() {
            let index = Int32(offset + 1), result: Int32
            switch value {
            case .text(let text): result = sqlite3_bind_text(stmt, index, text, -1, transient)
            case .number(let number): result = sqlite3_bind_double(stmt, index, number)
            case .blob(let bytes): result = bytes.withUnsafeBytes { sqlite3_bind_blob(stmt, index, $0.baseAddress, Int32(bytes.count), transient) }
            case .null: result = sqlite3_bind_null(stmt, index)
            }
            guard result == SQLITE_OK else { sqlite3_finalize(stmt); throw ConfigurationError("同步历史参数无效") }
        }
        return stmt
    }
    private func mutate(_ sql: String, _ values: [Value] = []) throws {
        let stmt = try statement(sql, values); defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_DONE else { throw ConfigurationError("同步历史保存失败，原文件已保留") }
    }
    private func decode<T: Decodable>(_ type: T.Type, _ stmt: OpaquePointer, column: Int32 = 0) throws -> T {
        let count = Int(sqlite3_column_bytes(stmt, column))
        guard let bytes = sqlite3_column_blob(stmt, column), count > 0 else { throw ConfigurationError("同步历史记录无法读取") }
        return try decoder.decode(type, from: Data(bytes: bytes, count: count))
    }
    private func entry(_ id: String) throws -> SyncHistoryEntry? {
        let stmt = try statement("SELECT payload FROM history_entries WHERE id=?", [.text(id)]); defer { sqlite3_finalize(stmt) }
        switch sqlite3_step(stmt) { case SQLITE_ROW: return try decode(SyncHistoryEntry.self, stmt); case SQLITE_DONE: return nil; default: throw ConfigurationError("同步历史读取失败") }
    }
    public func apply(_ events: [SyncHistoryEvent], now: Date = Date()) throws {
        lock.lock(); defer { closeConnection(); lock.unlock() }; try open()
        try execute("BEGIN IMMEDIATE")
        var changed = false
        do {
            let cutoff = now.addingTimeInterval(-Self.retention)
            for event in events where event.date >= cutoff {
                var current = try entry(event.entryID) ?? SyncHistoryEntry(id: event.entryID, context: event.context,
                    batchID: event.batchID, state: event.state, queuedAt: event.legacy ? nil : event.queuedAt ?? (event.state == .queued ? event.date : nil),
                    updatedAt: event.date, summary: event.summary ?? SyncHistorySummary(), attempts: 0, legacy: event.legacy)
                try mutate("INSERT OR IGNORE INTO history_entries VALUES(?,?,?,?,?)", [.text(current.id), .text(current.context.taskID.uuidString), .number(current.updatedAt.timeIntervalSince1970), .text(current.state.rawValue), .blob(try encoder.encode(current))])
                let activity = SyncHistoryActivity(id: event.id, date: event.date, state: event.state, attemptID: event.attemptID, message: event.message, httpStatus: event.httpStatus)
                try mutate("INSERT OR IGNORE INTO history_events VALUES(?,?,?,?,?)", [.text(event.id), .text(event.entryID), .number(event.date.timeIntervalSince1970), event.attemptID.map(Value.text) ?? .null, .blob(try encoder.encode(activity))])
                guard sqlite3_changes(db) > 0 else { continue }
                changed = true
                if event.date >= current.updatedAt && (current.state != .succeeded || event.state == .succeeded) {
                    current.state = event.state; current.updatedAt = event.date; current.message = event.message; current.httpStatus = event.httpStatus
                }
                if let summary = event.summary { current.summary = summary }
                if event.state == .succeeded {
                    if event.confirmationTimeKnown != false { current.confirmedAt = current.confirmedAt ?? event.date }
                    current.state = .succeeded
                }
                let count = try statement("SELECT COUNT(DISTINCT attempt_id) FROM history_events WHERE entry_id=?", [.text(current.id)])
                guard sqlite3_step(count) == SQLITE_ROW else { sqlite3_finalize(count); throw ConfigurationError("同步历史尝试次数读取失败") }
                current.attempts = Int(sqlite3_column_int(count, 0)); sqlite3_finalize(count)
                try mutate("UPDATE history_entries SET updated_at=?,state=?,payload=? WHERE id=?", [.number(current.updatedAt.timeIntervalSince1970), .text(current.state.rawValue), .blob(try encoder.encode(current)), .text(current.id)])
            }
            try pruneRows(now: now)
            try execute("COMMIT")
            if changed { NotificationCenter.default.post(name: .syncHistoryChanged, object: nil, userInfo: ["path": file.path]) }
        } catch { try? execute("ROLLBACK"); throw error }
    }
    private func pruneRows(now: Date) throws {
        let cutoff = now.addingTimeInterval(-Self.retention).timeIntervalSince1970
        try mutate("DELETE FROM history_entries WHERE updated_at<?", [.number(cutoff)])
        // A recent retry keeps the whole batch timeline; expired batches cascade their events.
    }
    public func prune(now: Date = Date()) throws {
        lock.lock(); defer { closeConnection(); lock.unlock() }; try open(); try pruneRows(now: now)
    }
    public func page(taskID: UUID? = nil, filter: SyncHistoryFilter = .all, cursor: SyncHistoryCursor? = nil, limit: Int = 50, now: Date = Date()) throws -> SyncHistoryPage {
        lock.lock(); defer { closeConnection(); lock.unlock() }; try open()
        let limit = max(1, min(50, limit))
        var conditions = ["updated_at>=?"], values: [Value] = [.number(now.addingTimeInterval(-Self.retention).timeIntervalSince1970)]
        if let taskID { conditions.append("task_id=?"); values.append(.text(taskID.uuidString)) }
        if filter == .success { conditions.append("state='succeeded'") }
        if filter == .attention { conditions.append("state!='succeeded'") }
        if let cursor { conditions.append("(updated_at<? OR (updated_at=? AND id<?))"); values += [.number(cursor.date.timeIntervalSince1970), .number(cursor.date.timeIntervalSince1970), .text(cursor.id)] }
        values.append(.number(Double(limit + 1)))
        let stmt = try statement("SELECT payload FROM history_entries WHERE \(conditions.joined(separator: " AND ")) ORDER BY updated_at DESC,id DESC LIMIT ?", values)
        defer { sqlite3_finalize(stmt) }
        var entries: [SyncHistoryEntry] = []
        while true {
            let status = sqlite3_step(stmt)
            if status == SQLITE_DONE { break }
            guard status == SQLITE_ROW else { throw ConfigurationError("同步历史查询失败") }
            entries.append(try decode(SyncHistoryEntry.self, stmt))
        }
        let more = entries.count > limit
        if more { entries.removeLast() }
        let cursor = more ? entries.last.map { SyncHistoryCursor(date: $0.updatedAt, id: $0.id) } : nil
        return SyncHistoryPage(entries: entries, nextCursor: cursor)
    }
    public func detail(_ id: String, now: Date = Date()) throws -> SyncHistoryDetail? {
        lock.lock(); defer { closeConnection(); lock.unlock() }; try open()
        guard let entry = try entry(id), entry.updatedAt >= now.addingTimeInterval(-Self.retention) else { return nil }
        let stmt = try statement("SELECT payload FROM history_events WHERE entry_id=? ORDER BY at DESC,id DESC", [.text(id)])
        defer { sqlite3_finalize(stmt) }
        var events: [SyncHistoryActivity] = []
        while true {
            let status = sqlite3_step(stmt)
            if status == SQLITE_DONE { break }
            guard status == SQLITE_ROW else { throw ConfigurationError("同步历史详情读取失败") }
            events.append(try decode(SyncHistoryActivity.self, stmt))
        }
        return SyncHistoryDetail(entry: entry, events: events)
    }
}

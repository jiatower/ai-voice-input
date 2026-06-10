import ApplicationServices
import Foundation

struct Hotkey {
  let name: String
  let keyCode: Int64
  let modifiers: Int64
}

let modifierFlags: [(Int64, CGEventFlags)] = [
  (1, .maskCommand),
  (2, .maskControl),
  (4, .maskAlternate),
  (8, .maskShift)
]

func hasRequiredModifiers(_ flags: CGEventFlags, required: Int64) -> Bool {
  for (bit, flag) in modifierFlags {
    let requiredFlag = (required & bit) != 0
    if flags.contains(flag) != requiredFlag {
      return false
    }
  }
  return true
}

func parseHotkeys() -> [Hotkey] {
  guard let data = ProcessInfo.processInfo.environment["AI_VOICE_HOTKEYS"]?.data(using: .utf8) else {
    return []
  }
  let raw = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] ?? []
  return raw.compactMap { item in
    guard
      let name = item["name"] as? String,
      let keyCode = item["keyCode"] as? Int64,
      let modifiers = item["modifiers"] as? Int64
    else {
      return nil
    }
    return Hotkey(name: name, keyCode: keyCode, modifiers: modifiers)
  }
}

let hotkeys = parseHotkeys()
var pressed = Set<String>()
var activeByName = [String: Hotkey]()

func emit(_ phase: String, _ name: String) {
  FileHandle.standardOutput.write("\(phase) \(name)\n".data(using: .utf8)!)
}

func release(_ hotkey: Hotkey) {
  if pressed.contains(hotkey.name) {
    pressed.remove(hotkey.name)
    activeByName.removeValue(forKey: hotkey.name)
    emit("up", hotkey.name)
  }
}

func releaseDroppedModifiers(_ flags: CGEventFlags) {
  for hotkey in Array(activeByName.values) where !hasRequiredModifiers(flags, required: hotkey.modifiers) {
    release(hotkey)
  }
}

let mask =
  (1 << CGEventType.keyDown.rawValue) |
  (1 << CGEventType.keyUp.rawValue) |
  (1 << CGEventType.flagsChanged.rawValue)
guard let eventTap = CGEvent.tapCreate(
  tap: .cgSessionEventTap,
  place: .headInsertEventTap,
  options: .listenOnly,
  eventsOfInterest: CGEventMask(mask),
  callback: { _, type, event, _ in
    let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
    let flags = event.flags

    if type == .keyDown {
      for hotkey in hotkeys where hotkey.keyCode == keyCode && hasRequiredModifiers(flags, required: hotkey.modifiers) {
        if !pressed.contains(hotkey.name) {
          pressed.insert(hotkey.name)
          activeByName[hotkey.name] = hotkey
          emit("down", hotkey.name)
        }
        break
      }
    } else if type == .keyUp {
      for hotkey in Array(activeByName.values) where hotkey.keyCode == keyCode {
        release(hotkey)
        break
      }
    } else if type == .flagsChanged {
      releaseDroppedModifiers(flags)
    }

    return Unmanaged.passUnretained(event)
  },
  userInfo: nil
) else {
  FileHandle.standardError.write("failed to create event tap\n".data(using: .utf8)!)
  exit(2)
}

emit("ready", "hotkeys")

let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: eventTap, enable: true)
CFRunLoopRun()

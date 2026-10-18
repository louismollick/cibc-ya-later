import AppKit
func png(_ path: String, size: CGFloat, draw: () -> Void) {
 // Template images use alpha as their mask, so the background must be transparent.
 let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
 NSGraphicsContext.saveGraphicsState()
 NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
 NSColor.clear.setFill()
 NSRect(x: 0, y: 0, width: size, height: size).fill(using: .copy)
 draw()
 NSGraphicsContext.restoreGraphicsState()
 try! bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}
png("resources/icon.png", size: 1024) {
 NSColor.black.setFill(); NSBezierPath(roundedRect: NSRect(x: 32,y: 32,width: 960,height: 960),xRadius: 210,yRadius: 210).fill()
 let text = "C" as NSString
 text.draw(at: NSPoint(x: 170,y: 164),withAttributes: [.font: NSFont.systemFont(ofSize: 620,weight: .bold),.foregroundColor: NSColor.white])
 NSColor.white.setStroke()
 let arrow = NSBezierPath();arrow.lineWidth = 54;arrow.lineCapStyle = .round;arrow.lineJoinStyle = .round
 arrow.move(to: NSPoint(x: 605,y: 510));arrow.line(to: NSPoint(x: 833,y: 510));arrow.move(to: NSPoint(x: 757,y: 592));arrow.line(to: NSPoint(x: 839,y: 510));arrow.line(to: NSPoint(x: 757,y: 428));arrow.stroke()
}
png("resources/trayTemplate.png", size: 36) {
 NSColor.black.setStroke()
 let arrow=NSBezierPath();arrow.lineWidth=3;arrow.lineCapStyle = .round;arrow.lineJoinStyle = .round
 arrow.move(to: NSPoint(x: 18,y: 30));arrow.line(to: NSPoint(x: 18,y: 12));arrow.move(to: NSPoint(x: 10,y: 20));arrow.line(to: NSPoint(x: 18,y: 12));arrow.line(to: NSPoint(x: 26,y: 20));arrow.move(to: NSPoint(x: 7,y: 9));arrow.line(to: NSPoint(x: 7,y: 5));arrow.line(to: NSPoint(x: 29,y: 5));arrow.line(to: NSPoint(x: 29,y: 9));arrow.stroke()
}

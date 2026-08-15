// Despia MCP - the JVM face, as its own Gradle build.
//
// Standalone on purpose, exactly as the Despia AI JVM face is. `bindings/kotlin`
// is the ANDROID library (com.despia:mcp, an AAR) and needs the Android Gradle
// Plugin and an SDK; this is `com.despia:mcp-jvm`, the plain-JAR face that
// Compose Desktop and server-side consumers need, and it must build and TEST
// with nothing but a JDK.
//
// That is what lets the socket tests run on any lane. They bind a real
// listener and read the bound addresses back, and a lane that needed an
// emulator to do that is a lane nobody runs.

rootProject.name = "despia-mcp-jvm"

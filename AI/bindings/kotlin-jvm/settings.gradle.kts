// Despia AI - the JVM face, as its own Gradle build.
//
// Standalone on purpose. `bindings/kotlin` is the ANDROID library (com.despia:ai,
// an AAR) and needs the Android Gradle Plugin and an SDK; this is
// `com.despia:ai-jvm`, the plain-JAR face that Compose Desktop and server-side
// consumers need, and it must build and TEST with nothing but a JDK. Keeping
// them separate is what lets the conformance corpus run on a lane that has no
// Android SDK at all.

rootProject.name = "despia-ai-jvm"

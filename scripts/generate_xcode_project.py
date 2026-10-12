#!/usr/bin/env python3
"""Generate the small native project without a third-party project generator."""
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT / "ios/HealthRelay.xcodeproj"

def identifier(label):
    return hashlib.sha1(label.encode()).hexdigest()[:24].upper()

def q(value):
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"') + '"'

objects = []
def obj(name, isa, fields):
    value = identifier(name)
    objects.append(f"\t\t{value} = {{isa = {isa}; {fields} }};")
    return value

def array(values):
    return "(" + ", ".join(values) + ",)" if values else "()"

app_sources = sorted((ROOT / "ios/HealthRelay").glob("*.swift"))
test_sources = sorted((ROOT / "ios/HealthRelayUITests").glob("*.swift"))
app_files, app_build, test_files, test_build = [], [], [], []
for files, refs, builds in [(app_sources, app_files, app_build), (test_sources, test_files, test_build)]:
    for source in files:
        path = source.relative_to(ROOT / "ios").as_posix()
        ref = obj("file:" + path, "PBXFileReference", f"lastKnownFileType = sourcecode.swift; path = {q(path)}; sourceTree = SOURCE_ROOT;")
        refs.append(ref)
        builds.append(obj("build:" + path, "PBXBuildFile", f"fileRef = {ref};"))

app_product = obj("appProduct", "PBXFileReference", 'explicitFileType = wrapper.application; path = HealthRelay.app; sourceTree = BUILT_PRODUCTS_DIR;')
test_product = obj("testProduct", "PBXFileReference", 'explicitFileType = wrapper.cfbundle; path = HealthRelayUITests.xctest; sourceTree = BUILT_PRODUCTS_DIR;')
package = obj("package", "XCLocalSwiftPackageReference", 'relativePath = ../packages/HealthRelayCore;')
package_product = obj("packageProduct", "XCSwiftPackageProductDependency", f"package = {package}; productName = HealthRelayCore;")
package_build = obj("packageBuild", "PBXBuildFile", f"productRef = {package_product};")
sources = obj("appSources", "PBXSourcesBuildPhase", f"buildActionMask = 2147483647; files = {array(app_build)}; runOnlyForDeploymentPostprocessing = 0;")
frameworks = obj("appFrameworks", "PBXFrameworksBuildPhase", f"buildActionMask = 2147483647; files = {array([package_build])}; runOnlyForDeploymentPostprocessing = 0;")
resources = obj("appResources", "PBXResourcesBuildPhase", "buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;")
test_phase = obj("testSources", "PBXSourcesBuildPhase", f"buildActionMask = 2147483647; files = {array(test_build)}; runOnlyForDeploymentPostprocessing = 0;")
test_frameworks = obj("testFrameworks", "PBXFrameworksBuildPhase", "buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;")

def configs(prefix, extra):
    config_ids = []
    for mode in ["Debug", "Release"]:
        common = {
            "SWIFT_VERSION": "6.0", "IPHONEOS_DEPLOYMENT_TARGET": "18.0", "SDKROOT": "iphoneos",
            "CLANG_ENABLE_MODULES": "YES", "SWIFT_OPTIMIZATION_LEVEL": "-Onone" if mode == "Debug" else "-O",
            "DEBUG_INFORMATION_FORMAT": "dwarf" if mode == "Debug" else "dwarf-with-dsym",
            "ENABLE_TESTABILITY": "YES" if mode == "Debug" else "NO",
            "ONLY_ACTIVE_ARCH": "YES" if mode == "Debug" else "NO",
            "SWIFT_ACTIVE_COMPILATION_CONDITIONS": "DEBUG" if mode == "Debug" else "",
        }
        common.update(extra)
        settings = " ".join(f"{key} = {q(value)};" for key, value in common.items())
        config_ids.append(obj(prefix + mode, "XCBuildConfiguration", f"buildSettings = {{{settings}}}; name = {mode};"))
    return obj(prefix + "List", "XCConfigurationList", f"buildConfigurations = {array(config_ids)}; defaultConfigurationIsVisible = 0; defaultConfigurationName = Release;")

project_configs = configs("project", {})
app_configs = configs("app", {
    "PRODUCT_NAME": "$(TARGET_NAME)", "PRODUCT_BUNDLE_IDENTIFIER": "org.healthrelay.app",
    "GENERATE_INFOPLIST_FILE": "YES", "INFOPLIST_FILE": "HealthRelay/Info.plist", "MARKETING_VERSION": "0.1.0", "CURRENT_PROJECT_VERSION": "1",
    "CODE_SIGN_STYLE": "Automatic", "CODE_SIGN_ENTITLEMENTS": "HealthRelay/HealthRelay.entitlements",
    "TARGETED_DEVICE_FAMILY": "1,2", "SUPPORTED_PLATFORMS": "iphoneos iphonesimulator",
    "INFOPLIST_KEY_CFBundleDisplayName": "HealthRelay", "INFOPLIST_KEY_UILaunchScreen_Generation": "YES",
    "INFOPLIST_KEY_UIApplicationSceneManifest_Generation": "YES",
    "INFOPLIST_KEY_NSHealthShareUsageDescription": "读取你选择的健康记录，并按你配置的自动化规则上传到你的接收接口。",
    "INFOPLIST_KEY_UISupportedInterfaceOrientations": "UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft UIInterfaceOrientationLandscapeRight",
})
test_configs = configs("test", {
    "PRODUCT_NAME": "$(TARGET_NAME)", "PRODUCT_BUNDLE_IDENTIFIER": "org.healthrelay.app.uitests",
    "GENERATE_INFOPLIST_FILE": "YES", "CODE_SIGN_STYLE": "Automatic", "TEST_TARGET_NAME": "HealthRelay",
    "TARGETED_DEVICE_FAMILY": "1,2", "SUPPORTED_PLATFORMS": "iphoneos iphonesimulator",
})

app_target = obj("appTarget", "PBXNativeTarget", f"buildConfigurationList = {app_configs}; buildPhases = {array([sources, frameworks, resources])}; buildRules = (); dependencies = (); name = HealthRelay; productName = HealthRelay; productReference = {app_product}; productType = \"com.apple.product-type.application\"; packageProductDependencies = {array([package_product])};")
proxy = obj("testProxy", "PBXContainerItemProxy", f"containerPortal = {identifier('project')}; proxyType = 1; remoteGlobalIDString = {app_target}; remoteInfo = HealthRelay;")
dependency = obj("testDependency", "PBXTargetDependency", f"target = {app_target}; targetProxy = {proxy};")
test_target = obj("testTarget", "PBXNativeTarget", f"buildConfigurationList = {test_configs}; buildPhases = {array([test_phase, test_frameworks])}; buildRules = (); dependencies = {array([dependency])}; name = HealthRelayUITests; productName = HealthRelayUITests; productReference = {test_product}; productType = \"com.apple.product-type.bundle.ui-testing\";")
source_group = obj("sourceGroup", "PBXGroup", f"children = {array(app_files)}; name = App; sourceTree = \"<group>\";")
test_group = obj("testGroup", "PBXGroup", f"children = {array(test_files)}; name = UITests; sourceTree = \"<group>\";")
products = obj("products", "PBXGroup", f"children = {array([app_product, test_product])}; name = Products; sourceTree = \"<group>\";")
main = obj("mainGroup", "PBXGroup", f"children = {array([source_group, test_group, products])}; sourceTree = \"<group>\";")
project = obj("project", "PBXProject", f"attributes = {{LastUpgradeCheck = 2700; TargetAttributes = {{{app_target} = {{CreatedOnToolsVersion = 27.0; SystemCapabilities = {{com.apple.HealthKit = {{enabled = 1;}};}};}}; {test_target} = {{CreatedOnToolsVersion = 27.0; TestTargetID = {app_target};}};}};}}; buildConfigurationList = {project_configs}; compatibilityVersion = \"Xcode 15.0\"; developmentRegion = zh-Hans; knownRegions = (en, zh-Hans, Base); mainGroup = {main}; productRefGroup = {products}; projectDirPath = \"\"; projectRoot = \"\"; packageReferences = {array([package])}; targets = {array([app_target, test_target])};")

PROJECT.mkdir(parents=True, exist_ok=True)
(PROJECT / "project.pbxproj").write_text("// !$*UTF8*$!\n{\n\tarchiveVersion = 1;\n\tclasses = {};\n\tobjectVersion = 60;\n\tobjects = {\n" + "\n".join(objects) + f"\n\t}};\n\trootObject = {project};\n}}\n")
scheme = f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2700" version="1.3">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries>
    <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{app_target}" BuildableName="HealthRelay.app" BlueprintName="HealthRelay" ReferencedContainer="container:HealthRelay.xcodeproj"/></BuildActionEntry>
  </BuildActionEntries></BuildAction>
  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables>
    <TestableReference skipped="NO"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{test_target}" BuildableName="HealthRelayUITests.xctest" BlueprintName="HealthRelayUITests" ReferencedContainer="container:HealthRelay.xcodeproj"/></TestableReference>
  </Testables></TestAction>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{app_target}" BuildableName="HealthRelay.app" BlueprintName="HealthRelay" ReferencedContainer="container:HealthRelay.xcodeproj"/></BuildableProductRunnable></LaunchAction>
  <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugServiceExtension="internal"/>
  <AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
'''
schemes = PROJECT / "xcshareddata/xcschemes"
schemes.mkdir(parents=True, exist_ok=True)
(schemes / "HealthRelay.xcscheme").write_text(scheme)
print(f"Generated {PROJECT.relative_to(ROOT)} ({len(app_sources)} app files, {len(test_sources)} UI test files)")

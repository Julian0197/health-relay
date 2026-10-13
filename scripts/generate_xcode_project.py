#!/usr/bin/env python3
"""Generate the small native project without a third-party project generator."""
import hashlib
import os
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

app_sources = sorted((ROOT / "ios/HealthRelay").glob("*.swift")) + sorted((ROOT / "shared").glob("*.swift"))
watch_sources = sorted((ROOT / "watch/HealthRelayWatch").glob("*.swift")) + sorted((ROOT / "shared").glob("*.swift")) + [ROOT / "ios/HealthRelay/HealthKitReader.swift"]
test_sources = sorted((ROOT / "ios/HealthRelayUITests").glob("*.swift"))
app_files, app_build, test_files, test_build, watch_files, watch_build = [], [], [], [], [], []
file_refs = {}
for target, files, refs, builds in [("app", app_sources, app_files, app_build), ("test", test_sources, test_files, test_build), ("watch", watch_sources, watch_files, watch_build)]:
    for source in files:
        path = os.path.relpath(source, ROOT / "ios")
        ref = file_refs.get(path) or obj("file:" + path, "PBXFileReference", f"lastKnownFileType = sourcecode.swift; path = {q(path)}; sourceTree = SOURCE_ROOT;")
        file_refs[path] = ref
        refs.append(ref)
        builds.append(obj(target + "build:" + path, "PBXBuildFile", f"fileRef = {ref};"))

app_product = obj("appProduct", "PBXFileReference", 'explicitFileType = wrapper.application; path = HealthRelay.app; sourceTree = BUILT_PRODUCTS_DIR;')
watch_product = obj("watchProduct", "PBXFileReference", 'explicitFileType = wrapper.application; path = HealthRelayWatch.app; sourceTree = BUILT_PRODUCTS_DIR;')
test_product = obj("testProduct", "PBXFileReference", 'explicitFileType = wrapper.cfbundle; path = HealthRelayUITests.xctest; sourceTree = BUILT_PRODUCTS_DIR;')
package = obj("package", "XCLocalSwiftPackageReference", 'relativePath = ../packages/HealthRelayCore;')
package_product = obj("packageProduct", "XCSwiftPackageProductDependency", f"package = {package}; productName = HealthRelayCore;")
watch_package_product = obj("watchPackageProduct", "XCSwiftPackageProductDependency", f"package = {package}; productName = HealthRelayCore;")
watch_package_build = obj("watchPackageBuild", "PBXBuildFile", f"productRef = {watch_package_product};")
package_build = obj("packageBuild", "PBXBuildFile", f"productRef = {package_product};")
sources = obj("appSources", "PBXSourcesBuildPhase", f"buildActionMask = 2147483647; files = {array(app_build)}; runOnlyForDeploymentPostprocessing = 0;")
frameworks = obj("appFrameworks", "PBXFrameworksBuildPhase", f"buildActionMask = 2147483647; files = {array([package_build])}; runOnlyForDeploymentPostprocessing = 0;")
resources = obj("appResources", "PBXResourcesBuildPhase", "buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;")
watch_sources_phase = obj("watchSources", "PBXSourcesBuildPhase", f"buildActionMask = 2147483647; files = {array(watch_build)}; runOnlyForDeploymentPostprocessing = 0;")
watch_frameworks = obj("watchFrameworks", "PBXFrameworksBuildPhase", f"buildActionMask = 2147483647; files = {array([watch_package_build])}; runOnlyForDeploymentPostprocessing = 0;")
watch_embed_build = obj("watchEmbedBuild", "PBXBuildFile", f"fileRef = {watch_product}; settings = {{ATTRIBUTES = (RemoveHeadersOnCopy,);}};")
watch_embed = obj("watchEmbed", "PBXCopyFilesBuildPhase", f'buildActionMask = 2147483647; dstPath = "$(CONTENTS_FOLDER_PATH)/Watch"; dstSubfolderSpec = 16; files = {array([watch_embed_build])}; name = "Embed Watch Content"; runOnlyForDeploymentPostprocessing = 0;')
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

watch_configs = configs("watch", {
    "PRODUCT_NAME": "$(TARGET_NAME)", "PRODUCT_BUNDLE_IDENTIFIER": "org.healthrelay.app.watch",
    "SDKROOT": "watchos", "WATCHOS_DEPLOYMENT_TARGET": "11.0", "SUPPORTED_PLATFORMS": "watchos watchsimulator",
    "TARGETED_DEVICE_FAMILY": "4", "GENERATE_INFOPLIST_FILE": "YES", "INFOPLIST_FILE": "../watch/HealthRelayWatch/Info.plist",
    "CODE_SIGN_STYLE": "Automatic", "CODE_SIGN_ENTITLEMENTS": "../watch/HealthRelayWatch/HealthRelayWatch.entitlements",
    "MARKETING_VERSION": "0.1.0", "CURRENT_PROJECT_VERSION": "1", "SKIP_INSTALL": "YES",
    "INFOPLIST_KEY_CFBundleDisplayName": "HealthRelay", "ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME": "",
})
watch_target = obj("watchTarget", "PBXNativeTarget", f'buildConfigurationList = {watch_configs}; buildPhases = {array([watch_sources_phase, watch_frameworks])}; buildRules = (); dependencies = (); name = HealthRelayWatch; productName = HealthRelayWatch; productReference = {watch_product}; productType = "com.apple.product-type.application"; packageProductDependencies = {array([watch_package_product])};')
watch_proxy = obj("watchProxy", "PBXContainerItemProxy", f"containerPortal = {identifier('project')}; proxyType = 1; remoteGlobalIDString = {watch_target}; remoteInfo = HealthRelayWatch;")
watch_dependency = obj("watchDependency", "PBXTargetDependency", f"target = {watch_target}; targetProxy = {watch_proxy};")
app_target = obj("appTarget", "PBXNativeTarget", f"buildConfigurationList = {app_configs}; buildPhases = {array([sources, frameworks, resources, watch_embed])}; buildRules = (); dependencies = {array([watch_dependency])}; name = HealthRelay; productName = HealthRelay; productReference = {app_product}; productType = \"com.apple.product-type.application\"; packageProductDependencies = {array([package_product])};")
proxy = obj("testProxy", "PBXContainerItemProxy", f"containerPortal = {identifier('project')}; proxyType = 1; remoteGlobalIDString = {app_target}; remoteInfo = HealthRelay;")
dependency = obj("testDependency", "PBXTargetDependency", f"target = {app_target}; targetProxy = {proxy};")
test_target = obj("testTarget", "PBXNativeTarget", f"buildConfigurationList = {test_configs}; buildPhases = {array([test_phase, test_frameworks])}; buildRules = (); dependencies = {array([dependency])}; name = HealthRelayUITests; productName = HealthRelayUITests; productReference = {test_product}; productType = \"com.apple.product-type.bundle.ui-testing\";")
unit_sources = sorted((ROOT / "ios/HealthRelayTests").glob("*.swift"))
unit_files, unit_build = [], []
for source in unit_sources:
    path = source.relative_to(ROOT / "ios").as_posix()
    ref = obj("file:" + path, "PBXFileReference", f"lastKnownFileType = sourcecode.swift; path = {q(path)}; sourceTree = SOURCE_ROOT;")
    unit_files.append(ref)
    unit_build.append(obj("build:" + path, "PBXBuildFile", f"fileRef = {ref};"))
unit_product = obj("unitProduct", "PBXFileReference", 'explicitFileType = wrapper.cfbundle; path = HealthRelayTests.xctest; sourceTree = BUILT_PRODUCTS_DIR;')
unit_phase = obj("unitSources", "PBXSourcesBuildPhase", f"buildActionMask = 2147483647; files = {array(unit_build)}; runOnlyForDeploymentPostprocessing = 0;")
unit_frameworks = obj("unitFrameworks", "PBXFrameworksBuildPhase", "buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;")
unit_configs = configs("unit", {
    "PRODUCT_NAME": "$(TARGET_NAME)", "PRODUCT_BUNDLE_IDENTIFIER": "org.healthrelay.app.tests",
    "GENERATE_INFOPLIST_FILE": "YES", "CODE_SIGN_STYLE": "Automatic",
    "TEST_HOST": "$(BUILT_PRODUCTS_DIR)/HealthRelay.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/HealthRelay",
    "BUNDLE_LOADER": "$(TEST_HOST)", "TARGETED_DEVICE_FAMILY": "1,2",
})
unit_target = obj("unitTarget", "PBXNativeTarget", f'buildConfigurationList = {unit_configs}; buildPhases = {array([unit_phase, unit_frameworks])}; buildRules = (); dependencies = {array([dependency])}; name = HealthRelayTests; productName = HealthRelayTests; productReference = {unit_product}; productType = "com.apple.product-type.bundle.unit-test";')
unit_group = obj("unitGroup", "PBXGroup", f'children = {array(unit_files)}; name = Tests; sourceTree = "<group>";')

watch_unit_files, watch_unit_build = [], []
for source in sorted((ROOT / "watch/HealthRelayWatchTests").glob("*.swift")) + [ROOT / "ios/HealthRelayTests/ObserverWorkTests.swift"]:
    path = os.path.relpath(source, ROOT / "ios")
    ref = identifier("file:" + path) if source.parent.name == "HealthRelayTests" else obj("file:" + path, "PBXFileReference", f"lastKnownFileType = sourcecode.swift; path = {q(path)}; sourceTree = SOURCE_ROOT;")
    watch_unit_files.append(ref)
    watch_unit_build.append(obj("watchUnitBuild:" + path, "PBXBuildFile", f"fileRef = {ref};"))
watch_unit_product = obj("watchUnitProduct", "PBXFileReference", 'explicitFileType = wrapper.cfbundle; path = HealthRelayWatchTests.xctest; sourceTree = BUILT_PRODUCTS_DIR;')
watch_unit_phase = obj("watchUnitSources", "PBXSourcesBuildPhase", f"buildActionMask = 2147483647; files = {array(watch_unit_build)}; runOnlyForDeploymentPostprocessing = 0;")
watch_unit_frameworks = obj("watchUnitFrameworks", "PBXFrameworksBuildPhase", "buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0;")
watch_unit_configs = configs("watchUnit", {
    "PRODUCT_NAME": "$(TARGET_NAME)", "PRODUCT_BUNDLE_IDENTIFIER": "org.healthrelay.app.watch.tests",
    "GENERATE_INFOPLIST_FILE": "YES", "CODE_SIGN_STYLE": "Automatic",
    "SDKROOT": "watchos", "WATCHOS_DEPLOYMENT_TARGET": "11.0", "SUPPORTED_PLATFORMS": "watchos watchsimulator",
    "TEST_HOST": "$(BUILT_PRODUCTS_DIR)/HealthRelayWatch.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/HealthRelayWatch",
    "BUNDLE_LOADER": "$(TEST_HOST)", "TARGETED_DEVICE_FAMILY": "4",
})
watch_unit_target = obj("watchUnitTarget", "PBXNativeTarget", f'buildConfigurationList = {watch_unit_configs}; buildPhases = {array([watch_unit_phase, watch_unit_frameworks])}; buildRules = (); dependencies = {array([watch_dependency])}; name = HealthRelayWatchTests; productName = HealthRelayWatchTests; productReference = {watch_unit_product}; productType = "com.apple.product-type.bundle.unit-test";')
watch_unit_group = obj("watchUnitGroup", "PBXGroup", f'children = {array(watch_unit_files)}; name = WatchTests; sourceTree = "<group>";')

source_group = obj("sourceGroup", "PBXGroup", f"children = {array(app_files)}; name = App; sourceTree = \"<group>\";")
test_group = obj("testGroup", "PBXGroup", f"children = {array(test_files)}; name = UITests; sourceTree = \"<group>\";")
watch_group = obj("watchGroup", "PBXGroup", f'children = {array([ref for ref in watch_files if ref not in app_files])}; name = Watch; sourceTree = "<group>";')
products = obj("products", "PBXGroup", f"children = {array([app_product, watch_product, test_product, unit_product, watch_unit_product])}; name = Products; sourceTree = \"<group>\";")
main = obj("mainGroup", "PBXGroup", f"children = {array([source_group, watch_group, test_group, unit_group, watch_unit_group, products])}; sourceTree = \"<group>\";")
project = obj("project", "PBXProject", f"attributes = {{LastUpgradeCheck = 2700; TargetAttributes = {{{app_target} = {{CreatedOnToolsVersion = 27.0; SystemCapabilities = {{com.apple.HealthKit = {{enabled = 1;}};}};}}; {test_target} = {{CreatedOnToolsVersion = 27.0; TestTargetID = {app_target};}};}};}}; buildConfigurationList = {project_configs}; compatibilityVersion = \"Xcode 15.0\"; developmentRegion = zh-Hans; knownRegions = (en, zh-Hans, Base); mainGroup = {main}; productRefGroup = {products}; projectDirPath = \"\"; projectRoot = \"\"; packageReferences = {array([package])}; targets = {array([app_target, watch_target, test_target, unit_target, watch_unit_target])};")

PROJECT.mkdir(parents=True, exist_ok=True)
(PROJECT / "project.pbxproj").write_text("// !$*UTF8*$!\n{\n\tarchiveVersion = 1;\n\tclasses = {};\n\tobjectVersion = 60;\n\tobjects = {\n" + "\n".join(objects) + f"\n\t}};\n\trootObject = {project};\n}}\n")
scheme = f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="2700" version="1.3">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries>
    <BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{app_target}" BuildableName="HealthRelay.app" BlueprintName="HealthRelay" ReferencedContainer="container:HealthRelay.xcodeproj"/></BuildActionEntry>
  </BuildActionEntries></BuildAction>
  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables>
    <TestableReference skipped="NO"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{test_target}" BuildableName="HealthRelayUITests.xctest" BlueprintName="HealthRelayUITests" ReferencedContainer="container:HealthRelay.xcodeproj"/></TestableReference>
    <TestableReference skipped="NO"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{unit_target}" BuildableName="HealthRelayTests.xctest" BlueprintName="HealthRelayTests" ReferencedContainer="container:HealthRelay.xcodeproj"/></TestableReference>
  </Testables></TestAction>
  <LaunchAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{app_target}" BuildableName="HealthRelay.app" BlueprintName="HealthRelay" ReferencedContainer="container:HealthRelay.xcodeproj"/></BuildableProductRunnable></LaunchAction>
  <ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" savedToolIdentifier="" useCustomWorkingDirectory="NO" debugServiceExtension="internal"/>
  <AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>
'''
schemes = PROJECT / "xcshareddata/xcschemes"
schemes.mkdir(parents=True, exist_ok=True)
(schemes / "HealthRelay.xcscheme").write_text(scheme)
watch_scheme = scheme.replace(app_target, watch_target).replace('BuildableName="HealthRelay.app"', 'BuildableName="HealthRelayWatch.app"').replace('BlueprintName="HealthRelay"', 'BlueprintName="HealthRelayWatch"')
start = watch_scheme.index('  <TestAction')
end = watch_scheme.index('  <LaunchAction')
watch_test_action = f'''  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv="YES"><Testables>
    <TestableReference skipped="NO"><BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{watch_unit_target}" BuildableName="HealthRelayWatchTests.xctest" BlueprintName="HealthRelayWatchTests" ReferencedContainer="container:HealthRelay.xcodeproj"/></TestableReference>
  </Testables></TestAction>
'''
watch_scheme = watch_scheme[:start] + watch_test_action + watch_scheme[end:]
(schemes / "HealthRelayWatch.xcscheme").write_text(watch_scheme)
print(f"Generated {PROJECT.relative_to(ROOT)} ({len(app_sources)} app files, {len(test_sources)} UI test files)")

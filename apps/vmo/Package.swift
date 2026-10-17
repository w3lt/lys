// swift-tools-version: 6.3
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "vmo",
    platforms: [.macOS("26.0")],
    products: [
        .executable(name: "vmo", targets: ["vmo"])
    ],
    dependencies: [
        .package(url: "https://github.com/apple/containerization", exact: "0.52.0")
    ],
    targets: [
        // Targets are the basic building blocks of a package, defining a module or a test suite.
        // Targets can depend on other targets in this package and products from dependencies.
        .executableTarget(
            name: "vmo",
            dependencies: [
                .product(name: "Containerization", package: "containerization")
            ]
        ),
        .testTarget(
            name: "vmoTests",
            dependencies: ["vmo"]
        ),
    ],
    swiftLanguageModes: [.v6]
)

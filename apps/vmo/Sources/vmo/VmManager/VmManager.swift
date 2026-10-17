import Foundation
import Containerization
import ContainerizationOS

private let initfsReference = "ghcr.io/apple/containerization/vminit:0.52.0"
private let kernelPath = FileManager.default // TODO: this only works on my machine, we need another way to manage this
    .homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/com.apple.container/kernels/vmlinux-6.18.35-197-debug")

private let imageReference = "docker.io/library/alpine:3.24.2"

private let kernel = Kernel(path: kernelPath, platform: .linuxArm)


class VmManager {
    private var containerManager: ContainerManager
    private var activeVms: Set<String>
    
    init() async throws {
        self.activeVms = []
        self.containerManager = try await ContainerManager(
            kernel: kernel,
            initfsReference: initfsReference,
            network: try VmnetNetwork()
        )
    }
    
    public func createVm() async throws -> String {
        let current = try Terminal.current
        try current.setraw()
        defer { current.tryReset() }

        let newContainerId = UUID().uuidString
        let container = try await self.containerManager.create(
            newContainerId,
            reference: imageReference,
            rootfsSizeInBytes: 1.gib()
        ) { @Sendable config in
            config.cpus = 2
            config.memoryInBytes = 521.mib()
            config.process.setTerminalIO(terminal: current)
            config.process.arguments = ["/bin/sh"]
            config.process.workingDirectory = "/"
        }
        
        self.activeVms.insert(newContainerId)
        return newContainerId
    }
    
    public func stopVm(containerId: String) throws {
        do {
            try self.containerManager.delete(containerId)
            activeVms.remove(containerId)
        } catch {
            print("ERROR Stopping VM: \(error)\n")
        }
    }
}

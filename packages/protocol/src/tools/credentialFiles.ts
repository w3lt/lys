import * as z from "zod"
import credentialFilesJson from "./credentialFiles.json"

/**
 * Validates one name or name part of the credential file list: non-empty,
 * lowercase, and without a path separator, so it matches one path part.
 */
const credentialNameSchema = z
  .string()
  .regex(/^[^/\\]+$/u)
  .refine((name) => name === name.toLowerCase(), {
    message: "Credential names are lowercase"
  })

/** Validates one list of credential names; each name appears once. */
const credentialNameListSchema = z
  .array(credentialNameSchema)
  .min(1)
  .refine((names) => new Set(names).size === names.length, {
    message: "Credential names appear once"
  })
  .readonly()

/**
 * Validates the credential file list in `credentialFiles.json`.
 *
 * @remarks The desktop host parses the same file with its own reader, which
 * also refuses unknown keys.
 */
const credentialFileListSchema = z
  .strictObject({
    /**
     * Folders whose every file is treated as a private key or credential:
     * SSH, GnuPG, AWS, Azure, Kubernetes, and Docker settings, and the macOS
     * keychains.
     */
    folderNames: credentialNameListSchema,
    /**
     * Names of private keys and of files that hold passwords or tokens: SSH
     * keys, `.netrc` files, the PostgreSQL password file, Git's stored
     * credentials, npm and PyPI settings, Apache password files, and `.env`
     * files.
     */
    fileNames: credentialNameListSchema,
    /** Starts of file names, such as `.env.` for one environment's file. */
    fileNamePrefixes: credentialNameListSchema,
    /**
     * Ends of the names of private keys, certificates with their keys,
     * keystores, and password databases.
     */
    fileNameEndings: credentialNameListSchema
  })
  .readonly()

/** Private key and credential file names that Lys never lets a tool read. */
export type CredentialFileList = z.infer<typeof credentialFileListSchema>

/**
 * Private key and credential file names, in lowercase, that Lys never lets a
 * tool read: the backend's tool call policy denies a call whose arguments
 * name one, and the desktop's file tools refuse a file whose real path has
 * one as a part.
 *
 * @remarks Read from `credentialFiles.json`, which the desktop host embeds
 * too, so the two sides read one list. Validated when this module loads; an
 * invalid list fails the import.
 */
export const CREDENTIAL_FILE_LIST: CredentialFileList =
  credentialFileListSchema.parse(credentialFilesJson)

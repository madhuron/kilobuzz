// Объявления интерфейсов Audio Processing Object (APO) звукового движка Windows.
// В Windows SDK они лежат в audioenginebaseapo.h; в mingw-w64 этого заголовка нет,
// поэтому повторяем публичный ABI здесь (порядок методов в vtable важен).
#pragma once
#include <windows.h>
#include <unknwn.h>
#include <mmreg.h>
#include <audioapotypes.h>

struct IAudioMediaType;

typedef enum APO_CONNECTION_BUFFER_TYPE {
  APO_CONNECTION_BUFFER_TYPE_ALLOCATED = 0,
  APO_CONNECTION_BUFFER_TYPE_EXTERNAL = 1,
  APO_CONNECTION_BUFFER_TYPE_DEPENDANT = 2
} APO_CONNECTION_BUFFER_TYPE;

typedef struct APO_CONNECTION_DESCRIPTOR {
  APO_CONNECTION_BUFFER_TYPE Type;
  UINT_PTR pBuffer;
  UINT32 u32MaxFrameCount;
  IAudioMediaType *pFormat;
  UINT32 u32Signature;
} APO_CONNECTION_DESCRIPTOR;

typedef enum APO_FLAG {
  APO_FLAG_NONE = 0x0,
  APO_FLAG_INPLACE = 0x1,
  APO_FLAG_SAMPLESPERFRAME_MUST_MATCH = 0x2,
  APO_FLAG_FRAMESPERSECOND_MUST_MATCH = 0x4,
  APO_FLAG_BITSPERSAMPLE_MUST_MATCH = 0x8,
  APO_FLAG_MIXER = 0x10,
  APO_FLAG_DEFAULT = 0xE
} APO_FLAG;

typedef struct APO_REG_PROPERTIES {
  CLSID clsid;
  APO_FLAG Flags;
  WCHAR szFriendlyName[256];
  WCHAR szCopyrightInfo[256];
  UINT32 u32MajorVersion;
  UINT32 u32MinorVersion;
  UINT32 u32MinInputConnections;
  UINT32 u32MaxInputConnections;
  UINT32 u32MinOutputConnections;
  UINT32 u32MaxOutputConnections;
  UINT32 u32MaxInstances;
  UINT32 u32NumAPOInterfaces;
  IID iidAPOInterfaceList[1];
} APO_REG_PROPERTIES;

typedef struct UNCOMPRESSEDAUDIOFORMAT {
  GUID guidFormatType;
  DWORD dwSamplesPerFrame;
  DWORD dwBytesPerSampleContainer;
  DWORD dwValidBitsPerSample;
  FLOAT fFramesPerSecond;
  DWORD dwChannelMask;
} UNCOMPRESSEDAUDIOFORMAT;

#define APOERR_FORMAT_NOT_SUPPORTED ((HRESULT)0x887D0003L)
#define APOERR_ALREADY_INITIALIZED ((HRESULT)0x887D0001L)
#define APOERR_NOT_INITIALIZED ((HRESULT)0x887D0002L)
#define APOERR_INVALID_CONNECTION_FORMAT ((HRESULT)0x887D0004L)
#define APOERR_APO_LOCKED ((HRESULT)0x887D0005L)

// {4E997F73-B71F-4798-873B-ED7DFCF15B4D}
MIDL_INTERFACE("4E997F73-B71F-4798-873B-ED7DFCF15B4D")
IAudioMediaType : public IUnknown {
 public:
  virtual HRESULT STDMETHODCALLTYPE IsCompressedFormat(BOOL *pfCompressed) = 0;
  virtual HRESULT STDMETHODCALLTYPE IsEqual(IAudioMediaType *pIAudioType, DWORD *pdwFlags) = 0;
  virtual const WAVEFORMATEX *STDMETHODCALLTYPE GetAudioFormat() = 0;
  virtual HRESULT STDMETHODCALLTYPE GetUncompressedAudioFormat(UNCOMPRESSEDAUDIOFORMAT *pUncompressedAudioFormat) = 0;
};

// {FD7F2B29-24D0-4B5C-B177-592C39F9CA10}
MIDL_INTERFACE("FD7F2B29-24D0-4B5C-B177-592C39F9CA10")
IAudioProcessingObject : public IUnknown {
 public:
  virtual HRESULT STDMETHODCALLTYPE Reset() = 0;
  virtual HRESULT STDMETHODCALLTYPE GetLatency(HNSTIME *pTime) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetRegistrationProperties(APO_REG_PROPERTIES **ppRegProps) = 0;
  virtual HRESULT STDMETHODCALLTYPE Initialize(UINT32 cbDataSize, BYTE *pbyData) = 0;
  virtual HRESULT STDMETHODCALLTYPE IsInputFormatSupported(IAudioMediaType *pOppositeFormat, IAudioMediaType *pRequestedInputFormat, IAudioMediaType **ppSupportedInputFormat) = 0;
  virtual HRESULT STDMETHODCALLTYPE IsOutputFormatSupported(IAudioMediaType *pOppositeFormat, IAudioMediaType *pRequestedOutputFormat, IAudioMediaType **ppSupportedOutputFormat) = 0;
  virtual HRESULT STDMETHODCALLTYPE GetInputChannelCount(UINT32 *pu32ChannelCount) = 0;
};

// {9E1D6A6D-DDBC-4E95-A4C7-AD64BA37846C}
MIDL_INTERFACE("9E1D6A6D-DDBC-4E95-A4C7-AD64BA37846C")
IAudioProcessingObjectRT : public IUnknown {
 public:
  virtual void STDMETHODCALLTYPE APOProcess(UINT32 u32NumInputConnections, APO_CONNECTION_PROPERTY **ppInputConnections, UINT32 u32NumOutputConnections, APO_CONNECTION_PROPERTY **ppOutputConnections) = 0;
  virtual UINT32 STDMETHODCALLTYPE CalcInputFrames(UINT32 u32OutputFrameCount) = 0;
  virtual UINT32 STDMETHODCALLTYPE CalcOutputFrames(UINT32 u32InputFrameCount) = 0;
};

// {0E5ED805-ABA6-49C3-8F9A-2B8C889C4FA8}
MIDL_INTERFACE("0E5ED805-ABA6-49C3-8F9A-2B8C889C4FA8")
IAudioProcessingObjectConfiguration : public IUnknown {
 public:
  virtual HRESULT STDMETHODCALLTYPE LockForProcess(UINT32 u32NumInputConnections, APO_CONNECTION_DESCRIPTOR **ppInputConnections, UINT32 u32NumOutputConnections, APO_CONNECTION_DESCRIPTOR **ppOutputConnections) = 0;
  virtual HRESULT STDMETHODCALLTYPE UnlockForProcess() = 0;
};

// {5FA00F27-ADD6-499A-8A9D-6B98521FA75B}
MIDL_INTERFACE("5FA00F27-ADD6-499A-8A9D-6B98521FA75B")
IAudioSystemEffects : public IUnknown {};

// {BAFE99D2-7436-44CE-9E0E-4D89AFBFFF56}
MIDL_INTERFACE("BAFE99D2-7436-44CE-9E0E-4D89AFBFFF56")
IAudioSystemEffects2 : public IAudioSystemEffects {
 public:
  virtual HRESULT STDMETHODCALLTYPE GetEffectsList(LPGUID *ppEffectsIds, UINT *pcEffects, HANDLE Event) = 0;
};

#ifdef __CRT_UUID_DECL
__CRT_UUID_DECL(IAudioMediaType, 0x4E997F73, 0xB71F, 0x4798, 0x87, 0x3B, 0xED, 0x7D, 0xFC, 0xF1, 0x5B, 0x4D)
__CRT_UUID_DECL(IAudioProcessingObject, 0xFD7F2B29, 0x24D0, 0x4B5C, 0xB1, 0x77, 0x59, 0x2C, 0x39, 0xF9, 0xCA, 0x10)
__CRT_UUID_DECL(IAudioProcessingObjectRT, 0x9E1D6A6D, 0xDDBC, 0x4E95, 0xA4, 0xC7, 0xAD, 0x64, 0xBA, 0x37, 0x84, 0x6C)
__CRT_UUID_DECL(IAudioProcessingObjectConfiguration, 0x0E5ED805, 0xABA6, 0x49C3, 0x8F, 0x9A, 0x2B, 0x8C, 0x88, 0x9C, 0x4F, 0xA8)
__CRT_UUID_DECL(IAudioSystemEffects, 0x5FA00F27, 0xADD6, 0x499A, 0x8A, 0x9D, 0x6B, 0x98, 0x52, 0x1F, 0xA7, 0x5B)
__CRT_UUID_DECL(IAudioSystemEffects2, 0xBAFE99D2, 0x7436, 0x44CE, 0x9E, 0x0E, 0x4D, 0x89, 0xAF, 0xBF, 0xFF, 0x56)
#endif

// Данные, которые звуковая система передаёт в IAudioProcessingObject::Initialize для системных эффектов
struct IPropertyStore;
struct IMMDeviceCollection;
typedef struct APOInitBaseStruct {
  UINT32 cbSize;
  CLSID clsid;
} APOInitBaseStruct;
typedef struct APOInitSystemEffects {
  APOInitBaseStruct APOInit;
  IPropertyStore *pAPOEndpointProperties;
  IPropertyStore *pAPOSystemEffectsProperties;
  void *pReserved;
  IMMDeviceCollection *pDeviceCollection;
} APOInitSystemEffects;
typedef struct APOInitSystemEffects2 {
  APOInitBaseStruct APOInit;
  IPropertyStore *pAPOEndpointProperties;
  IPropertyStore *pAPOSystemEffectsProperties;
  void *pReserved;
  IMMDeviceCollection *pDeviceCollection;
  UINT nSoftwareIoDeviceInCollection;
  UINT nSoftwareIoConnectorIndex;
  GUID AudioProcessingMode;
  BOOL InitializeForDiscoveryOnly;
} APOInitSystemEffects2;

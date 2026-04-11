import { Categories } from 'homebridge';

import HomeKitDevice from './baseDevice.js';
import {
  buildEnergyDescriptors,
  buildOnDescriptor,
  buildOutletInUseDescriptor,
} from './descriptorHelpers.js';
import type KasaPythonPlatform from '../platform.js';
import type { CharacteristicDescriptor, Plug } from './deviceTypes.js';

export default class HomeKitDevicePlug extends HomeKitDevice {
  /* eslint @typescript-eslint/no-explicit-any: 0 */
  private historyService: any;

  constructor(
    platform: KasaPythonPlatform,
    public kasaDevice: Plug,
  ) {
    super(platform, kasaDevice, Categories.OUTLET, 'OUTLET');
    this.setupPrimaryService();
    this.setupEveHistoryService();
  }

  private setupEveHistoryService () : void {
    const {Characteristic, Service, api, eve} = this.platform;
    const accessory = this.homebridgeAccessory;
    const outlet = accessory.getService(Service.Outlet);;
    this.historyService = new this.platform.HistoryService(
      'custom', accessory, { storage: 'fs' },
    );

    //LastActivation characteristic
    const lastActivation = eve.Characteristics.LastActivation;
    outlet?.addOptionalCharacteristic(lastActivation);
    outlet?.getCharacteristic(lastActivation).onGet(() => {
      const initialTime = this.historyService?.getInitialTime();
      const lastTime = accessory.context.lastActivation && initialTime
        ? Math.max(0, accessory.context.lastActivation - initialTime)
        : 0;
      return lastTime;
    });

    // On characteristic handler
    const On = outlet?.getCharacteristic(Characteristic.On);
    On?.on('change', async (event) => {
      if (event.newValue !== event.oldValue && event.reason === 'write') {
        accessory.context.lastActivation = Math.round(new Date().valueOf() / 1000);
        this.historyService?.addEntry({
          time: accessory.context.lastActivation,
          status: event.newValue ? 1 : 0,
        });
      }
    });
    this.historyService?.addEntry({
      time: Math.round(new Date().valueOf() / 1000),
      status: On?.value ? 1 : 0,
    });

    // LockPhysicalControls characteristic
    const lockControl = Characteristic.LockPhysicalControls;
    outlet?.addOptionalCharacteristic(lockControl);
    outlet?.getCharacteristic(lockControl).onGet(() =>
      Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED,
    );

    if (this.kasaDevice.feature_info.energy || this.kasaDevice.sys_info.energy) {
      const Watts = outlet?.getCharacteristic(eve.Characteristics.Consumption);
      Watts?.on('change', async (event) => {
        this.historyService?.addEntry({
          time: Math.round(new Date().valueOf() / 1000),
          power: event.newValue,
        });
      });
    } else {
      // dummy consumption service with TotalConsumption characteristic
      const dummy =
        accessory.getService(eve.Services.Consumption) ??
        accessory.addService(eve.Services.Consumption, `${this.name} Consumption`);
      dummy?.setHiddenService(true);
      dummy?.addOptionalCharacteristic(eve.Characteristics.TotalConsumption);
      dummy?.getCharacteristic(eve.Characteristics.TotalConsumption).setProps({
        perms: [
          api.hap.Perms.PAIRED_READ,
          api.hap.Perms.NOTIFY,
          api.hap.Perms.HIDDEN,
        ],
      });
    }
  }

  public async initialize(): Promise<void> {
    await this.startPolling();
  }

  protected getPrimaryServiceType() {
    return this.platform.Service.Outlet;
  }

  protected buildPrimaryDescriptors(): CharacteristicDescriptor[] {
    const C = this.platform.Characteristic;
    const energyChars = this.platform.energyCharacteristics;
    const syncGroup = 'outletState';
    const supportsEnergy = !!(this.kasaDevice.feature_info.energy || this.kasaDevice.sys_info.energy);
    const includeEnergyCharacteristics = !!(
      this.platform.config.energyOptions.enableEnergyMonitoring &&
      energyChars &&
      supportsEnergy
    );

    const onDescriptor = buildOnDescriptor(
      C,
      async (value, context) => {
        await this.deviceManager!.controlDevice(context.device.host, 'state', value);
      },
      supportsEnergy ? undefined : syncGroup,
    );

    const list: CharacteristicDescriptor[] = [
      onDescriptor,
      buildOutletInUseDescriptor(C, supportsEnergy, syncGroup),
    ];

    if (includeEnergyCharacteristics) {
      list.push(...buildEnergyDescriptors(energyChars));
    }

    return list;
  }

  public identify(): void {
    this.log.info('identify');
  }
}